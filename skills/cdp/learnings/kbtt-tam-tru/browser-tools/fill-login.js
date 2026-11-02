// learnings/kbtt-tam-tru/browser-tools/fill-login.js
// Set the Ant Design login inputs through the native value setter plus
// input/change events. Returns booleans only; never echoes a value.

async function fillLogin(args) {
  const { username, password } = args || {};
  const setField = (id, value) => {
    const el = document.getElementById(id) || document.querySelector('[id="' + id + '"]');
    if (!el || typeof value !== 'string') return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === value;
  };
  return {
    username: setField('form_item_username', username),
    password: setField('form_item_password', password),
  };
}
