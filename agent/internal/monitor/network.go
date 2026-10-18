package monitor

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"strings"
)

// NetworkInfo 包含嗅探到的网络信息
type NetworkInfo struct {
	PrimaryIP    string   `json:"primary_ip"`
	CandidateIPs []string `json:"candidate_ips"`
}

// DetectHostIP 探测宿主机/本机局域网 IP
// 返回优先级最高的 primaryIP，以及所有候选 candidateIPs
func DetectHostIP() (string, []string) {
	candidates := make([]string, 0)
	seen := make(map[string]bool)

	addCandidate := func(ipStr string) {
		ipStr = strings.TrimSpace(ipStr)
		if ipStr == "" || seen[ipStr] {
			return
		}
		// 排除环回和无效地址
		if ipStr == "127.0.0.1" || ipStr == "0.0.0.0" || strings.HasPrefix(ipStr, "127.") {
			return
		}
		seen[ipStr] = true
		candidates = append(candidates, ipStr)
	}

	// 1. 优先读取环境变量（由部署脚本直接在宿主机嗅探后注入容器）
	envIP := os.Getenv("FRP_HOST_IP")
	if envIP == "" {
		envIP = os.Getenv("HOST_IP")
	}
	if envIP != "" {
		parsed := net.ParseIP(strings.TrimSpace(envIP))
		if parsed != nil && !parsed.IsLoopback() && !parsed.IsUnspecified() {
			addCandidate(parsed.String())
		}
	}

	// 2. 检查 outbound UDP 路由（免发包探测出接口 IP）
	if outboundIP := getOutboundIP(); outboundIP != "" {
		addCandidate(outboundIP)
	}

	// 3. 遍历所有网卡接口
	interfaceIPs := getInterfaceIPv4s()
	for _, ip := range interfaceIPs {
		addCandidate(ip)
	}

	// 4. 若在容器 Bridge 模式下，尝试获取默认网关（即容器视角下的宿主机 Bridge IP）
	if gatewayIP := getDefaultGatewayLinux(); gatewayIP != "" {
		addCandidate(gatewayIP)
	}

	// 5. 检查 host.docker.internal（Docker Desktop 及配置了 host-gateway 的环境）
	if dockerInternalIPs, err := net.LookupHost("host.docker.internal"); err == nil {
		for _, dip := range dockerInternalIPs {
			parsed := net.ParseIP(dip)
			if parsed != nil && parsed.To4() != nil && !parsed.IsLoopback() {
				addCandidate(dip)
			}
		}
	}

	if len(candidates) == 0 {
		return "", candidates
	}

	// 排序打分，选取最符合“宿主机/局域网服务 IP”的地址作为 primaryIP
	bestIP := selectBestHostIP(candidates, envIP)
	return bestIP, candidates
}

// getOutboundIP 通过模拟拨号获取路由决策的本地出接口 IPv4
func getOutboundIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()

	localAddr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || localAddr.IP == nil {
		return ""
	}
	ipv4 := localAddr.IP.To4()
	if ipv4 == nil || ipv4.IsLoopback() || ipv4.IsUnspecified() {
		return ""
	}
	return ipv4.String()
}

// getInterfaceIPv4s 获取所有物理/虚拟网卡的非环回 IPv4 地址
func getInterfaceIPv4s() []string {
	var ips []string
	interfaces, err := net.Interfaces()
	if err != nil {
		return ips
	}

	for _, iface := range interfaces {
		// 跳过已停用或环回网卡
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}

		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}

			if ip == nil {
				continue
			}
			ipv4 := ip.To4()
			if ipv4 == nil || ipv4.IsLoopback() || ipv4.IsUnspecified() || ipv4.IsLinkLocalUnicast() {
				continue
			}

			ips = append(ips, ipv4.String())
		}
	}
	return ips
}

// getDefaultGatewayLinux 从 Linux /proc/net/route 解析默认网关 IPv4
func getDefaultGatewayLinux() string {
	file, err := os.Open("/proc/net/route")
	if err != nil {
		return ""
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		// /proc/net/route 格式: Iface Destination Gateway Flags ...
		// 默认网关 Destination 为 00000000
		if len(fields) >= 3 && fields[1] == "00000000" {
			gwHex := fields[2]
			if gwHex == "00000000" {
				continue
			}
			// Linux 内核存储为小端序 16 进制
			gwBytes, err := hex.DecodeString(gwHex)
			if err != nil || len(gwBytes) != 4 {
				continue
			}
			gwIP := net.IPv4(gwBytes[3], gwBytes[2], gwBytes[1], gwBytes[0])
			if gwIP != nil && gwIP.To4() != nil && !gwIP.IsLoopback() {
				return gwIP.String()
			}
		}
	}
	return ""
}

// selectBestHostIP 对候选 IP 评分，评选出最可能是宿主机/局域网服务的 IP
func selectBestHostIP(candidates []string, envIP string) string {
	if len(candidates) == 1 {
		return candidates[0]
	}

	bestScore := -9999
	bestIP := candidates[0]

	for _, ipStr := range candidates {
		score := scoreIP(ipStr, envIP)
		if score > bestScore {
			bestScore = score
			bestIP = ipStr
		}
	}

	return bestIP
}

// scoreIP 为候选 IP 计算优先级分数
func scoreIP(ipStr string, envIP string) int {
	// 若与宿主机环境变量传入的一致，给予最高置信度
	if envIP != "" && ipStr == envIP {
		return 1000
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return -100
	}
	ipv4 := ip.To4()
	if ipv4 == nil {
		return -100
	}

	// 排除环回与 APIPA
	if ipv4.IsLoopback() || ipv4.IsLinkLocalUnicast() {
		return -100
	}

	b0 := ipv4[0]
	b1 := ipv4[1]

	// 典型家庭与企业局域网网段 (192.168.x.x) - 极高概率是宿主机服务所在 IP
	if b0 == 192 && b1 == 168 {
		return 800
	}

	// 局域网 A 类私网 (10.x.x.x)
	if b0 == 10 {
		return 700
	}

	// B 类私网 (172.16.x.x - 172.31.x.x)
	if b0 == 172 && b1 >= 16 && b1 <= 31 {
		// 172.17.0.x 是 Docker 默认 bridge 子网，若作为容器内部网段优先级稍低，但仍可作为备选
		if b1 == 17 {
			return 400
		}
		return 600
	}

	// 公网 IP (例如直接部署在公网 VPS 宿主机上)
	return 500
}

// FormatCandidateIPs 将候选 IP 列表格式化为逗号分隔字符串
func FormatCandidateIPs(candidates []string) string {
	return strings.Join(candidates, ",")
}

// Helper for debugging
func (n NetworkInfo) String() string {
	return fmt.Sprintf("Primary: %s, Candidates: %v", n.PrimaryIP, n.CandidateIPs)
}
