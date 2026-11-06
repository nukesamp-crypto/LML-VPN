'use strict';
const net = require('node:net');
const { domainToASCII } = require('node:url');
const {PRESETS,buildRouting}=require('./routing.cjs');

const DEFAULTS = Object.freeze({
  engine: 'shiro',
  systemProxy: true,
  autoStart: false,
  cdnIPs: '',
  sniNames: '',
  region: '',
  lanternTag: '',
  routingPreset: 'global',
  routingCustom: ''
});

function splitList(value) {
  if (typeof value !== 'string' || value.length > 8000) throw new Error('متن فهرست بیش از حد طولانی است.');
  return [...new Set(value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];
}
function ipv4OrCIDR(value) {
  const parts = value.split('/');
  return parts.length <= 2 && net.isIP(parts[0]) === 4 && (parts.length === 1 || (/^\d{1,2}$/.test(parts[1]) && Number(parts[1]) <= 32));
}
function hostname(value) {
  const a = domainToASCII(value.toLowerCase().replace(/\.$/, ''));
  return !!a && a.length <= 253 && net.isIP(a) === 0 && a.split('.').every(x => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(x));
}
function parseCdn(value, sni) {
  const ips = splitList(value), names = splitList(sni).map(v => domainToASCII(v.toLowerCase().replace(/\.$/, '')));
  if (ips.length > 100 || names.length > 100) throw new Error('حداکثر ۱۰۰ آدرس یا دامنه مجاز است.');
  if (ips.some(x => !ipv4OrCIDR(x))) throw new Error('IP یا CIDR نامعتبر است. فقط IPv4 یا IPv4/CIDR وارد کن.');
  if (names.some(x => !hostname(x))) throw new Error('یکی از نام‌های SNI معتبر نیست.');
  if (names.length && !ips.length) throw new Error('برای استفاده از SNI سفارشی، حداقل یک IP یا CIDR لبهٔ CDN هم وارد کن.');
  return { ips, names };
}
function cleanSettings(raw = {}) {
  const r = { ...DEFAULTS };
  if (raw.engine === 'shiro' || raw.engine === 'lantern') r.engine = raw.engine;
  if (typeof raw.systemProxy === 'boolean') r.systemProxy = raw.systemProxy;
  if (typeof raw.autoStart === 'boolean') r.autoStart = raw.autoStart;
  if (typeof raw.cdnIPs === 'string') r.cdnIPs = raw.cdnIPs.slice(0, 8000);
  if (typeof raw.sniNames === 'string') r.sniNames = raw.sniNames.slice(0, 8000);
  if (typeof raw.region === 'string' && /^(?:|[A-Z]{2})$/.test(raw.region)) r.region = raw.region;
  if (typeof raw.lanternTag === 'string' && raw.lanternTag.length <= 256 && !/[\x00-\x1f]/.test(raw.lanternTag)) r.lanternTag = raw.lanternTag;
  if (typeof raw.routingPreset==='string' && PRESETS.has(raw.routingPreset)) r.routingPreset=raw.routingPreset;
  if (typeof raw.routingCustom==='string') r.routingCustom=raw.routingCustom.slice(0,12000);
  parseCdn(r.cdnIPs, r.sniNames);
  buildRouting({preset:r.routingPreset,custom:r.routingCustom});
  return r;
}
function psiphonConfig(base, settings, httpPort, socksPort, dataDir) {
  if (!base || typeof base !== 'object' || !base.PropagationChannelId || !base.SponsorId) throw new Error('پروفایل سایفون معتبر نیست.');
  const {ips,names} = parseCdn(settings.cdnIPs, settings.sniNames);
  const c = {...base,
    DataRootDirectory: dataDir,
    ClientPlatform: 'Windows_LML',
    LocalHttpProxyPort: httpPort,
    LocalSocksProxyPort: socksPort,
    EgressRegion: settings.region,
    DisableLocalSocksProxy: false,
    DisableLocalHTTPProxy: false,
    // Empty ListenInterface makes the upstream core bind to loopback.
    ListenInterface: '',
    EmitDiagnosticNotices: false,
    FrontedMeekCDNScanUseBuiltInSpec: true
  };
  // The real fork's key is FrontedMeekCDNScanSpec, NOT CustomServerEntries.
  delete c.FrontedMeekCDNScanSpec;
  if (ips.length) {
    c.FrontedMeekCDNScanSpec = {IPCandidates: ips};
    if (names.length) c.FrontedMeekCDNScanSpec.SNIServerNames = names;
  }
  return c;
}
module.exports = { DEFAULTS, cleanSettings, parseCdn, psiphonConfig, ipv4OrCIDR, hostname };
