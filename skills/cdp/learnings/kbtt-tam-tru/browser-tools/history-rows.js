// learnings/kbtt-tam-tru/browser-tools/history-rows.js
// Table rows as arrays of cell text; the empty-state row is skipped.

async function historyRows() {
  const rows = [];
  for (const tr of document.querySelectorAll('.ant-table-tbody tr')) {
    if (tr.classList.contains('ant-table-placeholder') || tr.classList.contains('ant-table-measure-row')) continue;
    const cells = Array.from(tr.querySelectorAll('td')).map((td) => (td.innerText || td.textContent || '').trim());
    if (cells.length === 0) continue;
    rows.push(cells);
  }
  return rows;
}
