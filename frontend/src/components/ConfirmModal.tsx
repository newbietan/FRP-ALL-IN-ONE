import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, Trash2, ArrowUpCircle, X } from 'lucide-react';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmType?: 'primary' | 'danger' | 'warning';
  onConfirm: () => void | Promise<void>;
}

interface ConfirmModalProps {
  dialog: ConfirmDialogOptions | null;
  onClose: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({ dialog, onClose }) => {
  const [loading, setLoading] = React.useState(false);

  if (!dialog) return null;

  const {
    title,
    message,
    confirmText = '确定',
    cancelText = '取消',
    confirmType = 'primary',
    onConfirm,
  } = dialog;

  const handleConfirm = async () => {
    try {
      setLoading(true);
      await onConfirm();
      onClose();
    } catch {
      // 错误由 onConfirm 自身处理
    } finally {
      setLoading(false);
    }
  };

  const getIcon = () => {
    switch (confirmType) {
      case 'danger':
        return (
          <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600 shrink-0">
            <Trash2 className="w-5 h-5" />
          </div>
        );
      case 'warning':
        return (
          <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
        );
      case 'primary':
      default:
        return (
          <div className="w-10 h-10 rounded-xl bg-sky-50 border border-sky-200 flex items-center justify-center text-[#006782] shrink-0">
            <ArrowUpCircle className="w-5 h-5" />
          </div>
        );
    }
  };

  const getConfirmButtonClass = () => {
    switch (confirmType) {
      case 'danger':
        return 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/20';
      case 'warning':
        return 'bg-amber-600 hover:bg-amber-700 text-white shadow-amber-600/20';
      case 'primary':
      default:
        return 'bg-[#006782] hover:bg-[#005166] text-white shadow-sky-900/20';
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="bg-white w-full max-w-md rounded-2xl border border-slate-200/80 p-6 shadow-2xl flex flex-col gap-4 text-left relative"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              {getIcon()}
              <div>
                <h3 className="font-headline font-bold text-base text-slate-900">{title}</h3>
                <span className="text-[10px] text-slate-400 font-mono">FRP-ALL-IN-ONE</span>
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={loading}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="text-xs text-slate-600 leading-relaxed whitespace-pre-line bg-slate-50 border border-slate-100 p-3.5 rounded-xl font-sans">
            {message}
          </div>

          {/* Footer Buttons */}
          <div className="flex justify-end items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer transition-colors"
            >
              {cancelText}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={loading}
              className={`px-5 py-2 rounded-lg text-xs font-semibold cursor-pointer shadow-sm transition-all flex items-center gap-1.5 ${getConfirmButtonClass()}`}
            >
              {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              <span>{confirmText}</span>
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
