const DOWNLOAD_LIMIT = 256 * 1024 ** 2;

// Invoke directly from the click handler so the browser keeps user activation.
export function downloadFile(file: File, name: string) {
  if (file.size > DOWNLOAD_LIMIT) {
    throw new Error("文件超过当前 256 MiB 导出上限，文件副本仍保留。");
  }
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
