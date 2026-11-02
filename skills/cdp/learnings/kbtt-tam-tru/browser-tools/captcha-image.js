// learnings/kbtt-tam-tru/browser-tools/captcha-image.js
// Base64 of the visible captcha data:image img (width > 100), or null.

async function captchaImage() {
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('data:image')) continue;
    if (img.getBoundingClientRect().width <= 100) continue;
    const comma = src.indexOf(',');
    return comma >= 0 ? src.slice(comma + 1) : null;
  }
  return null;
}
