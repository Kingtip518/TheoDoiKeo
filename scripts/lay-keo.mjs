// =====================================================================
//  LẤY KÈO TỰ ĐỘNG – chạy mỗi giờ trên GitHub (máy chủ miễn phí của GitHub)
//  Nguồn dữ liệu: The Odds API (the-odds-api.com)
//  Việc làm mỗi lần chạy:
//   1. Xem giải nào có trận sắp đá (bước này KHÔNG tốn lượt)
//   2. Lấy kèo tất cả các giải đó, dùng hết lượt thì thôi
//   3. Lưu lại kèo từng lần lấy  ->  data/lich-su.json
//   4. Nếu có trận kèo giảm mạnh  ->  báo Telegram (nếu đã cài)
//   5. Mỗi 3 giờ gửi bản tin Top 5 về Telegram
// =====================================================================

import fs from 'node:fs';
import { phanTichTran, moTaHinhDang, moTaPinnacle } from '../phan-tich.js';

// ---------------- CÀI ĐẶT (sửa số ở đây nếu muốn) ----------------
// Tự lấy danh sách TẤT CẢ giải bóng đá đang diễn ra từ nguồn dữ liệu (không tốn lượt)
const UU_TIEN_TRAN_SAP_DA_TRONG_SO_GIO = 6;          // trận sắp đá trong 6 giờ tới được lấy kèo dày hơn
const CHI_THEO_DOI_TRAN_DA_TRONG_SO_GIO_TOI = 24;  // chỉ theo dõi trận đá trong 24 giờ tới
const GIU_LAI_SO_LUOT_DU_PHONG = 0;                // dùng hết lượt thì thôi
const BAO_TELEGRAM_KHI_KEO_GIAM_TU_PHAN_TRAM = 10;  // giá trung bình giảm từ 10% trở lên mới báo
const BAO_TELEGRAM_KHI_SO_NHA_CAI_CUNG_GIAM_TU = 3; // phải có ít nhất 3 nhà cái cùng giảm
const GUI_BAN_TIN_TOP5_MOI_SO_GIO = 3;              // bản tin Top 5 gửi Telegram mỗi 3 giờ
const DIA_CHI_WEB = 'https://kingtip518.github.io/TheoDoiKeo/';
// ------------------------------------------------------------------

const MA_API = process.env.ODDS_API_KEY;
const TELEGRAM_MA_BOT = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_MA_NHOM = process.env.TELEGRAM_CHAT_ID || '';
const DIA_CHI_API = 'https://api.the-odds-api.com/v4';
const FILE_LICH_SU = 'data/lich-su.json';
const FILE_TRANG_THAI = 'data/trang-thai.json';

if (!MA_API) { console.error('Chưa có mã ODDS_API_KEY trong mục Secrets của GitHub'); process.exit(1); }

const docFile = (f, macDinh) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return macDinh; } };
const ghiFile = (f, v) => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

async function goiApi(duongDan) {
  const noi = duongDan.includes('?') ? '&' : '?';
  const r = await fetch(`${DIA_CHI_API}${duongDan}${noi}apiKey=${MA_API}`);
  const conLai = r.headers.get('x-requests-remaining');
  if (!r.ok) throw new Error(`Lỗi ${r.status}: ${await r.text()}`);
  return { duLieu: await r.json(), conLai: conLai === null ? null : Number(conLai) };
}

// Lấy giá 3 cửa [nhà, hòa, khách] của 1 nhà cái
function layGia3Cua(tran, nhaCai) {
  const keo = (nhaCai.markets || []).find(m => m.key === 'h2h');
  if (!keo) return null;
  let nha, hoa, khach;
  for (const o of keo.outcomes) {
    if (o.name === tran.home_team) nha = o.price;
    else if (o.name === tran.away_team) khach = o.price;
    else if (o.name === 'Draw') hoa = o.price;
  }
  return nha && hoa && khach ? [nha, hoa, khach] : null;
}

async function guiTelegram(noiDung) {
  if (!TELEGRAM_MA_BOT || !TELEGRAM_MA_NHOM) { console.log('Chưa cài mã Telegram nên không gửi'); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_MA_BOT}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_MA_NHOM, text: noiDung, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) { console.log('Gửi Telegram lỗi:', await r.text()); return false; }
    return true;
  } catch (e) { console.log('Gửi Telegram lỗi:', e.message); return false; }
}

const gioVN = ms => new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

// Bản tin Top 5 định kỳ – có trận chạy mạnh hay không cũng gửi
async function guiBanTinTop5(lichSu, trangThai, bayGio) {
  const dsTran = Object.values(lichSu.tran).filter(t => t.gioDa > bayGio);
  const soGiai = new Set(dsTran.map(t => t.giai)).size;
  const top5 = dsTran.map(t => ({ t, p: phanTichTran(t) }))
    .filter(x => x.p && x.p.duTieuChuanTop)
    .sort((a, b) => b.p.giam - a.p.giam).slice(0, 5);
  let noiDung = `📊 <b>BẢN TIN KÈO – ${gioVN(bayGio)}</b>\n` +
    `Đang theo dõi ${dsTran.length} trận / ${soGiai} giải · còn ${trangThai.conLai ?? '?'} lượt\n\n`;
  if (!top5.length) {
    noiDung += 'Chưa có trận nào kèo chạy mạnh.\n';
  } else {
    noiDung += '<b>Top 5 kèo giảm mạnh nhất:</b>\n';
    top5.forEach(({ t, p }, i) => {
      noiDung += `\n${i + 1}. <b>${t.nha} – ${t.khach}</b>\n   ${t.giai} · đá ${gioVN(t.gioDa)}\n` +
        `   💰 ${p.doiDuocDoTien}: ${p.giaDau.toFixed(2)} → ${p.giaMoi.toFixed(2)} (−${p.giam.toFixed(1)}%)\n` +
        `   ${p.soSoSanh ? `${p.soGiam}/${p.soSoSanh} nhà cái cùng giảm · ` : ''}${p.hinhDang === 'tu-tu' ? 'giảm từ từ' : p.hinhDang === 'dot-ngot' ? 'nhảy đột ngột' : 'mới 2 lần lấy'}\n`;
    });
  }
  noiDung += `\n🌐 ${DIA_CHI_WEB}`;
  return guiTelegram(noiDung);
}

async function chay() {
  const bayGio = Date.now();
  const lichSu = docFile(FILE_LICH_SU, { capNhat: 0, tran: {} });
  const trangThai = docFile(FILE_TRANG_THAI, { quyLuot: 0, conLai: null, lanLayCuoi: {}, daBao: {} });

  // 1. Lấy danh sách tất cả giải bóng đá, xem giải nào có trận sắp đá (không tốn lượt)
  const { duLieu: tatCaMon } = await goiApi('/sports');
  const CAC_GIAI = tatCaMon.filter(s => s.group === 'Soccer' && s.active && !s.has_outrights).map(s => ({ ma: s.key, ten: s.title }));
  const giaiCanLay = [];
  for (const g of CAC_GIAI) {
    try {
      const { duLieu, conLai } = await goiApi(`/sports/${g.ma}/events`);
      if (conLai !== null) trangThai.conLai = conLai;
      const gioDaSapNhat = Math.min(...duLieu.map(e => Date.parse(e.commence_time)).filter(t => t > bayGio), Infinity);
      if (gioDaSapNhat - bayGio < CHI_THEO_DOI_TRAN_DA_TRONG_SO_GIO_TOI * 3600e3) giaiCanLay.push({ ...g, gioDaSapNhat });
    } catch (e) { console.log(`${g.ten}: ${e.message}`); }
  }

  // 2. Số lượt được dùng = toàn bộ lượt còn lại
  const homNay = new Date(bayGio);
  const dauThangSau = Date.UTC(homNay.getUTCFullYear(), homNay.getUTCMonth() + 1, 1);
  const soGioConLai = Math.max(1, (dauThangSau - bayGio) / 3600e3);
  const luotDungDuoc = Math.max(0, (trangThai.conLai ?? 0) - GIU_LAI_SO_LUOT_DU_PHONG);
  trangThai.quyLuot = luotDungDuoc; // lấy hết tất cả giải mỗi lần chạy, còn lượt là lấy

  // Ưu tiên: giải lâu chưa lấy, và giải có trận sắp đá (sát giờ là lúc kèo bất thường hay chạy)
  const diemUuTien = g => {
    const soGioChuaLay = (bayGio - (trangThai.lanLayCuoi[g.ma] || 0)) / 3600e3;
    const sapDa = g.gioDaSapNhat - bayGio < UU_TIEN_TRAN_SAP_DA_TRONG_SO_GIO * 3600e3;
    return Math.min(soGioChuaLay, 1000) * (sapDa ? 3 : 1);
  };
  giaiCanLay.sort((a, b) => diemUuTien(b) - diemUuTien(a));

  // 3. Lấy kèo
  for (const g of giaiCanLay) {
    if (trangThai.quyLuot < 1) break;
    try {
      const { duLieu, conLai } = await goiApi(`/sports/${g.ma}/odds?regions=eu&markets=h2h&oddsFormat=decimal`);
      trangThai.quyLuot -= 1;
      if (conLai !== null) trangThai.conLai = conLai;
      trangThai.lanLayCuoi[g.ma] = bayGio;
      for (const ev of duLieu) {
        const batDau = Date.parse(ev.commence_time);
        if (batDau <= bayGio) continue; // trận đã đá thì thôi
        const giaNhaCai = {};
        for (const bk of ev.bookmakers || []) { const gia = layGia3Cua(ev, bk); if (gia) giaNhaCai[bk.key] = gia; }
        const ds = Object.values(giaNhaCai);
        if (!ds.length) continue;
        const tb = [0, 1, 2].map(i => +(ds.reduce((s, x) => s + x[i], 0) / ds.length).toFixed(3));
        const moc = { luc: bayGio, tb, pin: giaNhaCai.pinnacle || null, soNhaCai: ds.length };
        let t = lichSu.tran[ev.id];
        if (!t) {
          t = lichSu.tran[ev.id] = { id: ev.id, giai: g.ten, nha: ev.home_team, khach: ev.away_team, gioDa: batDau, ncDau: giaNhaCai, moc: [] };
        } else {
          for (const k in giaNhaCai) if (!t.ncDau[k]) t.ncDau[k] = giaNhaCai[k];
        }
        t.gioDa = batDau;
        t.ncMoi = giaNhaCai;
        t.moc.push(moc);
        if (t.moc.length > 80) t.moc.splice(1, t.moc.length - 80); // giữ mốc đầu + các mốc gần nhất
      }
    } catch (e) { console.log(`${g.ten}: ${e.message}`); }
  }

  // 4. Xóa trận đã đá xong (quá 3 giờ sau giờ bóng lăn)
  for (const id in lichSu.tran) if (lichSu.tran[id].gioDa < bayGio - 3 * 3600e3) delete lichSu.tran[id];
  for (const k in trangThai.daBao) if (!lichSu.tran[k.split('|')[0]]) delete trangThai.daBao[k];

  // 5. Báo Telegram trận kèo chạy mạnh (mỗi trận mỗi cửa chỉ báo 1 lần)
  for (const t of Object.values(lichSu.tran)) {
    const p = phanTichTran(t);
    if (!p || !p.duTieuChuanTop) continue;
    const khoa = `${t.id}|${p.cua}`;
    if (p.giam >= BAO_TELEGRAM_KHI_KEO_GIAM_TU_PHAN_TRAM && p.soGiam >= BAO_TELEGRAM_KHI_SO_NHA_CAI_CUNG_GIAM_TU && !trangThai.daBao[khoa]) {
      trangThai.daBao[khoa] = bayGio;
      const gio = gioVN(t.gioDa);
      await guiTelegram(
        `⚠️ <b>KÈO CHẠY MẠNH</b>\n${t.giai} – đá lúc ${gio}\n<b>${t.nha} – ${t.khach}</b>\n\n` +
        `💰 Được đổ tiền: <b>${p.doiDuocDoTien}</b>  ${p.giaDau.toFixed(2)} → ${p.giaMoi.toFixed(2)} (giảm ${p.giam.toFixed(1)}%)\n` +
        `❌ Bị bỏ: <b>${p.doiBiBo}</b>  ${p.giaBoDau.toFixed(2)} → ${p.giaBoMoi.toFixed(2)} (tăng ${p.tangBo.toFixed(1)}%)\n\n` +
        `${p.soGiam}/${p.soSoSanh} nhà cái cùng giảm\n${moTaPinnacle(p)}\n${moTaHinhDang(p)}` +
        (p.doiCuaDuoi ? '\n🚩 Đội cửa dưới được đổ tiền' : '') +
        (p.satGioDa ? '\n🚩 Kèo chạy sát giờ đá' : ''));
    }
  }

  // 6. Bản tin Top 5 mỗi 3 giờ (cho phép sớm 15 phút vì lịch chạy của GitHub hay bị trễ)
  if (bayGio - (trangThai.lanGuiBanTin || 0) >= GUI_BAN_TIN_TOP5_MOI_SO_GIO * 3600e3 - 15 * 60e3) {
    if (await guiBanTinTop5(lichSu, trangThai, bayGio)) trangThai.lanGuiBanTin = bayGio;
  }

  lichSu.capNhat = bayGio;
  trangThai.capNhat = bayGio;
  ghiFile(FILE_LICH_SU, lichSu);
  ghiFile(FILE_TRANG_THAI, trangThai);
  console.log(`Xong. Giải có trận: ${giaiCanLay.map(g => g.ten).join(', ') || 'không có'}. Lượt còn lại: ${trangThai.conLai}`);
}

await chay();
