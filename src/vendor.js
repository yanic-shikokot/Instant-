import { createIcons, icons } from 'lucide';
import { jsPDF } from 'jspdf';

window.lucide = {
  createIcons: (options) => {
    try {
      return createIcons({ icons, ...(options || {}) });
    } catch (e) {
      console.warn('FieldInspect: lucide icon render error:', e);
    }
  }
};

window.jspdf = { jsPDF };

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.lucide?.createIcons();
    });
  } else {
    window.lucide?.createIcons();
  }
}
