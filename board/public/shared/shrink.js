// Make a picture fit a size limit before it is uploaded, for a board that keeps its files in its database (FILE_STORAGE d1): one file
// may be about 1.5 MB there, and an ordinary screenshot as PNG is often bigger. fitImage draws such a picture again with the longest
// side at most 1600 px and saves it as JPEG (quality 0.85, then lower, then a smaller picture) until it fits.
// Whatever it cannot do comes back unchanged: a file that is already small enough, a GIF, a file that is not a picture, a browser whose
// canvas fails. The Worker's own limit (413 file_too_large) is the real guard, so a caller checks the size it gets back.
const STEPS = [[1600, 0.85], [1600, 0.7], [1280, 0.7], [1024, 0.6], [800, 0.5]]; // [longest side in px, JPEG quality]
const SHRINKABLE = ["image/png", "image/jpeg", "image/webp"];

function drawn(bitmap, side, quality) {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff"; // JPEG has no transparency
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export async function fitImage(file, maxBytes) {
  if (!maxBytes || file.size <= maxBytes || !SHRINKABLE.includes(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      for (const [side, quality] of STEPS) {
        const blob = await drawn(bitmap, side, quality);
        if (blob && blob.size <= maxBytes) {
          return new File([blob], (file.name || "image").replace(/\.[A-Za-z0-9]+$/, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
        }
      }
    } finally {
      bitmap.close?.();
    }
  } catch {}
  return file;
}
