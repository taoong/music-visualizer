/**
 * Error handling and user feedback utilities
 */

export interface ErrorDisplayOptions {
  duration?: number;
  type?: "error" | "warning" | "info";
}

/**
 * Display an error message to the user
 */
export function showError(
  message: string,
  options: ErrorDisplayOptions = {},
): void {
  const { duration = 5000, type = "error" } = options;

  // Create error element
  const errorEl = document.createElement("div");
  errorEl.className = `error-toast error-toast--${type}`;
  errorEl.textContent = message;
  errorEl.setAttribute("role", "alert");
  errorEl.setAttribute("aria-live", "assertive");

  // Add to DOM
  let container = document.getElementById("error-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "error-container";
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;
    document.body.appendChild(container);
  }

  container.appendChild(errorEl);

  // Animate in
  requestAnimationFrame(() => {
    errorEl.style.opacity = "1";
    errorEl.style.transform = "translateX(0)";
  });

  // Remove after duration
  setTimeout(() => {
    errorEl.style.opacity = "0";
    errorEl.style.transform = "translateX(100%)";
    setTimeout(() => errorEl.remove(), 300);
  }, duration);
}

/**
 * Show a loading/processing state
 */
export function setProcessingState(isProcessing: boolean, text?: string): void {
  const processing = document.getElementById("processing");
  const processingText = document.getElementById("processing-text");

  if (processing) {
    if (isProcessing) {
      processing.classList.remove("hidden");
      processing.setAttribute("aria-hidden", "false");
      if (text && processingText) {
        processingText.textContent = text;
      }
    } else {
      processing.classList.add("hidden");
      processing.setAttribute("aria-hidden", "true");
    }
  }
}

/**
 * Update splash screen file name with status
 */
export function setFileStatus(message: string, isError = false): void {
  const fileNameEl = document.getElementById("file-name");
  if (fileNameEl) {
    fileNameEl.textContent = message;
    fileNameEl.classList.toggle("error", isError);
  }
}

/**
 * Set play button disabled state
 */
export function setPlayButtonDisabled(disabled: boolean): void {
  const playBtn = document.getElementById(
    "play-btn",
  ) as HTMLButtonElement | null;
  if (playBtn) {
    playBtn.disabled = disabled;
  }
}

/**
 * Safe async wrapper with error handling
 */
export function safeAsync<T>(
  fn: () => Promise<T>,
  errorMessage: string,
): Promise<T | null> {
  return fn().catch((err) => {
    console.error(errorMessage, err);
    showError(errorMessage);
    return null;
  });
}

/**
 * Add error styles to document
 */
export function injectErrorStyles(): void {
  if (document.getElementById("error-styles")) return;

  const style = document.createElement("style");
  style.id = "error-styles";
  style.textContent = `
    .error-toast {
      background: #ff4444;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      max-width: 400px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      opacity: 0;
      transform: translateX(100%);
      transition: all 0.3s ease;
    }
    
    .error-toast--warning {
      background: #ff9800;
    }
    
    .error-toast--info {
      background: #2196f3;
    }
    
    #file-name.error {
      color: #ff4444;
    }
  `;
  document.head.appendChild(style);
}
