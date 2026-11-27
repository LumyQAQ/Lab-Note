'use strict';
const byId = id => document.getElementById(id);
let settings = null, working = false, reading = false;

function renderTailscale(ts) {
  const badge = byId('ts-badge');
  const desc = byId('ts-desc');
  const guide = byId('ts-guide');
  if (!badge || !desc) return;
  if (ts && ts.connected && ts.ip) {
    badge.textContent = `已连接 · ${ts.ip}`;
    badge.className = 'badge ok';
    desc.textContent = `已检测到本机 Tailscale 跨网地址 ${ts.ip}${ts.dns_name ? `（${ts.dns_name}）` : ''}。选中该地址开启共享后，已加入同一 Tailscale 网络的设备可以访问工作台。`;
    if (guide) guide.open = false;
  } else if (ts && ts.installed) {
    badge.textContent = '已安装 · 未登录/未连接';
    badge.className = 'badge warn';
    desc.textContent = '已检测到本机安装 Tailscale，请打开 Tailscale，登录并连接，然后点击下方「刷新地址」。';
    if (guide) guide.open = true;
  } else {
    badge.textContent = '未检测到';
    badge.className = 'badge';
    desc.textContent = '可以在下方选择局域网地址。需要跨网访问时，请先在电脑和移动设备上连接同一 Tailscale 网络。';
    if (guide) guide.open = true;
  }
}

function render(settings) {
  const {active, addresses, devices, auto_start, tailscale} = settings;
  renderTailscale(tailscale);
  byId('status').textContent = active ? '已开启' : '已关闭';
  byId('on').hidden = !active;
  byId('off').hidden = active;
  const selected = byId('address').value;
  byId('address').replaceChildren(...addresses.map(item => new Option(`${item.address} · ${item.label || item.interface}`, item.address)));
  if (addresses.some(x => x.address === selected)) byId('address').value = selected;
  byId('no-network').hidden = !!addresses.length;
  byId('start').disabled = !addresses.length || working;
  const autoOn = byId('autostart-on');
  if (autoOn) autoOn.checked = !!auto_start;
  if (active) {
    byId('url').textContent = settings.url;
    byId('network-changed').hidden = addresses.some(x => x.address === new URL(settings.url).hostname);
    const qr = byId('qr');
    if (qr.dataset.url !== settings.url) try {
      const matrix = qrcodegen.QrCode.encodeText(settings.url, qrcodegen.QrCode.Ecc.MEDIUM);
      const size = matrix.size + 8;
      qr.width = size; qr.height = size;
      const ctx = qr.getContext('2d');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#183b2d';
      for (let y = 0; y < matrix.size; y++) for (let x = 0; x < matrix.size; x++) if (matrix.getModule(x, y)) ctx.fillRect(x + 4, y + 4, 1, 1);
      qr.dataset.url = settings.url; qr.hidden = false;
    } catch { qr.hidden = true; }
  }
  byId('trust').hidden = !active || !settings.fingerprint;
  byId('fingerprint').textContent = settings.fingerprint.match(/.{1,2}/g)?.join(':') || '';
  byId('count').textContent = devices.length + ' 台';
  const list = byId('devices');
  list.replaceChildren();
  if (!devices.length) list.textContent = '暂无已配对设备。';
  for (const device of devices) {
    const row = document.createElement('div'), info = document.createElement('div'),
      name = document.createElement('strong'), date = document.createElement('small'),
      remove = document.createElement('button');
    row.className = 'device';
    name.textContent = device.name;
    date.textContent = '授权至 ' + new Date(device.expires * 1000).toLocaleDateString('zh-CN');
    remove.className = 'secondary';
    remove.textContent = '移除授权';
    remove.onclick = () => {
      if (confirm('移除「' + device.name + '」的授权？该设备下次访问时需要重新配对。')) {
        update({action: 'revoke', device_id: device.id});
      }
    };
    info.append(name, date);
    row.append(info, remove);
    list.append(row);
  }
  showCode();
}

function showCode() {
  if (!settings?.active) return;
  const seconds = Math.max(0, Math.ceil(settings.expires - Date.now() / 1000)), valid = settings.code && seconds;
  byId('code').textContent = valid ? settings.code : '—';
  byId('expiry').textContent = valid ? Math.ceil(seconds / 60) + ' 分钟内有效，每个码限配对一台设备' : '需要添加设备时，请生成新码。';
}

async function update(body) {
  if (working || (!body && reading)) return;
  if (body) working = true; else reading = true;
  const previous = settings;
  if (body) document.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const response = await fetch('/api/sharing', body
      ? {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Lab-Token': settings.token}, body: JSON.stringify(body)}
      : {cache: 'no-store'});
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '无法连接设备管理服务');
    if (!body && (working || settings !== previous)) return;
    byId('error').hidden = true;
    settings = data;
    render(settings);
  } catch (error) {
    byId('error').textContent = error.message;
    byId('error').hidden = false;
  } finally {
    if (body) {
      working = false;
      document.querySelectorAll('button').forEach(b => b.disabled = false);
      byId('start').disabled = !settings?.addresses?.length;
    } else reading = false;
  }
}

byId('start').onclick = () => update({action: 'start', address: byId('address').value, auto_start: !!byId('autostart-off')?.checked});
byId('stop').onclick = () => update({action: 'stop'});
byId('renew').onclick = () => update({action: 'code'});
byId('refresh').onclick = () => update();
byId('autostart-on')?.addEventListener('change', e => update({action: 'autostart', enabled: e.target.checked}));
byId('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(settings.url);
    byId('copy').textContent = '已复制';
  } catch {
    byId('url').focus();
    const range = document.createRange();
    range.selectNodeContents(byId('url'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
};
update();
setInterval(() => { if (!document.hidden) update(); }, 10000);
setInterval(showCode, 1000);
