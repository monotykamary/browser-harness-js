// learnings/kbtt-tam-tru/browser-tools/history-range.js
// On history-declare-manager: open the range picker, pick from then to, click
// "Tìm kiếm", return the picker's input values. No setTimeout (background tabs
// throttle it); waits use MessageChannel ticks with a hard deadline.

async function historyRange(args) {
  const { from, to } = args || {};
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(from) || !isDate(to)) return { ok: false, step: 'args', error: 'from and to must be YYYY-MM-DD' };

  const tick = () => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(0);
  });
  const until = async (probe, ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = probe();
      if (found) return found;
      if (Date.now() > deadline) return null;
      await tick();
    }
  };

  const startInput = document.querySelector('input[placeholder="Ngày bắt đầu"]');
  if (!startInput) return { ok: false, step: 'picker-input', error: 'start input not found' };
  const pickerRoot = startInput.closest('.ant-picker-range') || startInput.closest('.ant-picker');
  const readValues = () => Array.from((pickerRoot || document).querySelectorAll('input')).map((i) => i.value);

  startInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  startInput.focus();
  startInput.click();
  const panelUp = await until(() => document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) td[title]'), 3000);
  if (!panelUp) return { ok: false, step: 'open-picker', error: 'picker panel did not render' };

  const inViewTitles = () => Array.from(document.querySelectorAll('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) td.ant-picker-cell-in-view[title]')).map((td) => td.getAttribute('title')).sort();
  const cellFor = (date) => document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) td.ant-picker-cell-in-view[title="' + date + '"] .ant-picker-cell-inner')
    || document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) td[title="' + date + '"] .ant-picker-cell-inner');

  const pick = async (date, step) => {
    for (let hops = 0; hops < 36; hops++) {
      const inView = inViewTitles();
      const lo = inView[0];
      const hi = inView[inView.length - 1];
      const visible = lo && date >= lo && date <= hi;
      if (visible) break;
      const buttons = document.querySelectorAll('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-header-' + (date < lo ? 'prev' : 'next') + '-btn');
      const button = date < lo ? buttons[0] : buttons[buttons.length - 1];
      if (!button) return { ok: false, step, error: 'month nav button missing' };
      button.click();
      await tick();
    }
    const cell = cellFor(date);
    if (!cell) return { ok: false, step, error: 'date cell not found: ' + date };
    cell.click();
    await tick();
    return null;
  };

  const failFrom = await pick(from, 'pick-from');
  if (failFrom) return failFrom;
  const failTo = await pick(to, 'pick-to');
  if (failTo) return failTo;

  const searchButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Tìm kiếm');
  if (!searchButton) return { ok: false, step: 'search', error: 'Tìm kiếm button not found', values: readValues() };
  searchButton.click();
  await tick();
  return { ok: true, values: readValues() };
}
