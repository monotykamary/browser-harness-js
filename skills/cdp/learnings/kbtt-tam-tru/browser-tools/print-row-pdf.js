// learnings/kbtt-tam-tru/browser-tools/print-row-pdf.js
// Two-phase, re-callable. Call 1 clicks the print button on the first row whose
// text contains `match` and returns {status:"pending"} if the XEM TRƯỚC modal
// has not produced its blob iframe yet. Call again with the same args until
// {status:"done", base64, bytes}; the modal is closed on done. No setTimeout:
// waits use MessageChannel ticks, capped well under a second.

async function printRowPdf(args) {
  const match = args && args.match;
  if (typeof match !== 'string' || !match) return { status: 'error', error: 'match is required' };

  const tick = () => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(0);
  });
  const blobFrame = () => document.querySelector('.ant-modal iframe[src^="blob:"]');
  const waitFrame = async (ms) => {
    const deadline = Date.now() + ms;
    while (!blobFrame() && Date.now() < deadline) await tick();
    return blobFrame();
  };

  const state = window.__kbttPrint;
  const clickedRecently = state && state.match === match && Date.now() - state.at < 90000;

  let frame = blobFrame();
  if (!frame && !clickedRecently) {
    const row = Array.from(document.querySelectorAll('.ant-table-tbody tr')).find((tr) => (tr.textContent || '').includes(match));
    if (!row) return { status: 'error', error: 'no row matches' };
    const button = row.querySelector('td:last-child button');
    if (!button) return { status: 'error', error: 'print button not found in row' };
    window.__kbttPrint = { match, at: Date.now() };
    button.click();
    frame = await waitFrame(800);
  } else if (!frame) {
    frame = await waitFrame(300);
  }
  if (!frame) return { status: 'pending' };

  const blob = await (await fetch(frame.src)).blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const close = document.querySelector('.ant-modal-close');
  if (close) close.click();
  delete window.__kbttPrint;
  return { status: 'done', bytes: blob.size, type: blob.type, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}
