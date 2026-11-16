// =====================================================================
//  LẤY KÈO TỰ ĐỘNG – chạy mỗi giờ trên GitHub (máy chủ miễn phí của GitHub)
//  Nguồn dữ liệu: The Odds API (the-odds-api.com)
//  Việc làm mỗi lần chạy:
//   1. Xem giải nào có trận sắp đá (bước này KHÔNG tốn lượt)
//   2. Mỗi trận chỉ lấy kèo 3 lần: lần đầu thấy trận (làm mốc), 60 phút và 15 phút trước giờ đá
//   3. Lưu lại kèo từng lần lấy  ->  data/lich-su.json
//   4. Tại mốc 60 phút và 15 phút, kèo bất thường  ->  báo Telegram ngay
//   5. Mỗi 3 giờ gửi bản tin Top 5 về Telegram
//   6. Hết trận lấy tỷ số, đối chiếu với cửa được đổ tiền  ->  data/ket-qua.json + Telegram
// =====================================================================

import fs from 'node:fs';
import { phanTichTran, moTaHinhDang, moTaPinnacle } from '../phan-tich.js';

// ---------------- CÀI ĐẶT (sửa số ở đây nếu muốn) ----------------
// Tự lấy danh sách TẤT CẢ giải bóng đá đang diễn ra từ nguồn dữ liệu (không tốn lượt)
const LAY_KEO_TRUOC_GIO_DA_SO_PHUT = [60, 15];       // lấy kèo và báo tại 60 phút và 15 phút trước giờ đá
const LAY_MOC_DAU_TOI_DA_MOI_SO_GIO = 6;            // mỗi giải lấy mốc đầu (trận mới) tối đa 6 giờ 1 lần
const CHI_THEO_DOI_TRAN_DA_TRONG_SO_GIO_TOI = 24;  // chỉ theo dõi trận đá trong 24 giờ tới
const BAO_TELEGRAM_KHI_KEO_GIAM_TU_PHAN_TRAM = 20;  // giá trung bình giảm từ 20% trở lên mới báo
const BAO_TELEGRAM_KHI_SO_NHA_CAI_CUNG_GIAM_TU = 3; // phải có ít nhất 3 nhà cái cùng giảm
const GUI_BAN_TIN_TOP5_MOI_SO_GIO = 3;              // bản tin Top 5 gửi Telegram mỗi 3 giờ
const DIA_CHI_WEB = 'https://kingtip518.github.io/TheoDoiKeo/';
const LAY_KET_QUA_SAU_GIO_BONG_LAN_SO_GIO = 2;      // 2 giờ sau giờ bóng lăn mới đi lấy tỷ số
const BO_TRAN_KHONG_CO_KET_QUA_SAU_SO_GIO = 12;     // quá 12 giờ vẫn không có tỷ số thì bỏ
const CHI_DOI_CHIEU_TRAN_KEO_GIAM_TU_PHAN_TRAM = 20; // chỉ đối chiếu trận kèo giảm từ 20% (bất thường)
// ------------------------------------------------------------------

const MA_API = process.env.ODDS_API_KEY;
const TELEGRAM_MA_BOT = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_MA_NHOM = process.env.TELEGRAM_CHAT_ID || '';
const DIA_CHI_API = 'https://api.the-odds-api.com/v4';
const FILE_LICH_SU = 'data/lich-su.json';
const FILE_TRANG_THAI = 'data/trang-thai.json';
const FILE_KET_QUA = 'data/ket-qua.json';

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
    noiDung += 'Chưa có trận nào kèo giảm từ 20% trở lên.\n';
  } else {
    noiDung += '<b>Top 5 kèo bất thường (giảm từ 20%):</b>\n';
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
      const dsTran = duLieu.filter(e => { const t = Date.parse(e.commence_time); return t > bayGio && t - bayGio < CHI_THEO_DOI_TRAN_DA_TRONG_SO_GIO_TOI * 3600e3; });
      if (dsTran.length) giaiCanLay.push({ ...g, dsTran });
    } catch (e) { console.log(`${g.ten}: ${e.message}`); }
  }

  // 2. Chọn giải cần lấy kèo: có trận đang ở mốc 60 / 15 phút, hoặc có trận mới chưa có mốc đầu
  trangThai.daLayMoc ||= {};
  trangThai.lanLayDau ||= {};
  const tranOMoc = []; // các trận vừa được lấy kèo ở mốc 60 / 15 phút
  let coThayDoi = false;
  for (const g of giaiCanLay) {
    if ((trangThai.conLai ?? 0) < 1) { console.log('Hết lượt lấy kèo'); break; }
    const canMoc = [];
    for (const e of g.dsTran) {
      const conPhut = (Date.parse(e.commence_time) - bayGio) / 60e3;
      for (const m of LAY_KEO_TRUOC_GIO_DA_SO_PHUT) {
        const khoa = `${e.id}|${m}`;
        if (conPhut > Math.max(1, m - 12) && conPhut <= m + 12 && !trangThai.daLayMoc[khoa]) canMoc.push({ id: e.id, moc: m, khoa });
      }
    }
    const coTranMoi = g.dsTran.some(e => !lichSu.tran[e.id]) &&
      bayGio - (trangThai.lanLayDau[g.ma] || 0) > LAY_MOC_DAU_TOI_DA_MOI_SO_GIO * 3600e3;
    if (!canMoc.length && !coTranMoi) continue;

    // 3. Lấy kèo giải này (1 lượt)
    try {
      const { duLieu, conLai } = await goiApi(`/sports/${g.ma}/odds?regions=eu&markets=h2h&oddsFormat=decimal`);
      coThayDoi = true;
      if (conLai !== null) trangThai.conLai = conLai;
      trangThai.lanLayCuoi[g.ma] = bayGio;
      if (coTranMoi) trangThai.lanLayDau[g.ma] = bayGio;
      for (const c of canMoc) trangThai.daLayMoc[c.khoa] = bayGio;
      for (const ev of duLieu) {
        const batDau = Date.parse(ev.commence_time);
        if (batDau <= bayGio || batDau - bayGio > CHI_THEO_DOI_TRAN_DA_TRONG_SO_GIO_TOI * 3600e3) continue;
        const giaNhaCai = {};
        for (const bk of ev.bookmakers || []) { const gia = layGia3Cua(ev, bk); if (gia) giaNhaCai[bk.key] = gia; }
        const ds = Object.values(giaNhaCai);
        if (!ds.length) continue;
        const tb = [0, 1, 2].map(i => +(ds.reduce((s, x) => s + x[i], 0) / ds.length).toFixed(3));
        const mocCuaTran = canMoc.find(c => c.id === ev.id);
        const moc = { luc: bayGio, tb, pin: giaNhaCai.pinnacle || null, soNhaCai: ds.length, truocGioDa: mocCuaTran ? mocCuaTran.moc : null };
        let t = lichSu.tran[ev.id];
        if (!t) {
          t = lichSu.tran[ev.id] = { id: ev.id, ma: g.ma, giai: g.ten, nha: ev.home_team, khach: ev.away_team, gioDa: batDau, ncDau: giaNhaCai, moc: [] };
        } else {
          for (const k in giaNhaCai) if (!t.ncDau[k]) t.ncDau[k] = giaNhaCai[k];
        }
        t.gioDa = batDau;
        t.ma = g.ma;
        t.ncMoi = giaNhaCai;
        t.moc.push(moc);
        if (t.moc.length > 80) t.moc.splice(1, t.moc.length - 80);
        if (mocCuaTran) tranOMoc.push({ t, moc: mocCuaTran.moc });
      }
    } catch (e) { console.log(`${g.ten}: ${e.message}`); }
  }

  // Báo Telegram tại mốc 60 / 15 phút nếu kèo bất thường
  for (const { t, moc } of tranOMoc) {
    if (t.moc.length < 2) continue;
    const p = phanTichTran(t);
    if (!p || !p.duTieuChuanTop || p.soGiam < BAO_TELEGRAM_KHI_SO_NHA_CAI_CUNG_GIAM_TU || p.giam < BAO_TELEGRAM_KHI_KEO_GIAM_TU_PHAN_TRAM) continue;
    const khoa = `${t.id}|${p.cua}|${moc}`;
    if (trangThai.daBao[khoa]) continue;
    trangThai.daBao[khoa] = bayGio;
    await guiTelegram(
      `⚠️ <b>KÈO BẤT THƯỜNG – còn ${moc} phút</b>\n${t.giai} – đá lúc ${gioVN(t.gioDa)}\n<b>${t.nha} – ${t.khach}</b>\n\n` +
      `💰 Được đổ tiền: <b>${p.doiDuocDoTien}</b>  ${p.giaDau.toFixed(2)} → ${p.giaMoi.toFixed(2)} (giảm ${p.giam.toFixed(1)}%)\n` +
      `❌ Bị bỏ: <b>${p.doiBiBo}</b>  ${p.giaBoDau.toFixed(2)} → ${p.giaBoMoi.toFixed(2)} (tăng ${p.tangBo.toFixed(1)}%)\n\n` +
      `${p.soGiam}/${p.soSoSanh} nhà cái cùng giảm\n${moTaPinnacle(p)}\n${moTaHinhDang(p)}` +
      (p.doiCuaDuoi ? '\n🚩 Đội cửa dưới được đổ tiền' : ''));
  }

  // 4. Lấy tỷ số trận đã đá xong, đối chiếu với cửa được đổ tiền
  const ketQua = docFile(FILE_KET_QUA, { thongKe: {}, tran: [] });
  const maTheoTen = Object.fromEntries(CAC_GIAI.map(g => [g.ten, g.ma]));
  const choKetQua = Object.values(lichSu.tran).filter(t => t.gioDa < bayGio - LAY_KET_QUA_SAU_GIO_BONG_LAN_SO_GIO * 3600e3);
  const theoGiai = {};
  for (const t of choKetQua) { const ma = t.ma || maTheoTen[t.giai]; if (ma) (theoGiai[ma] ||= []).push(t); }
  const vuaXong = [];
  for (const [ma, ds] of Object.entries(theoGiai)) {
    if ((trangThai.conLai ?? 0) < 2) break; // mỗi lần lấy tỷ số tốn 2 lượt
    try {
      const { duLieu, conLai } = await goiApi(`/sports/${ma}/scores?daysFrom=1&eventIds=${ds.map(t => t.id).join(',')}`);
      if (conLai !== null) trangThai.conLai = conLai;
      for (const ev of duLieu) {
        const t = lichSu.tran[ev.id];
        if (!t || !ev.completed || !ev.scores) continue;
        const banNha = Number((ev.scores.find(x => x.name === t.nha) || {}).score);
        const banKhach = Number((ev.scores.find(x => x.name === t.khach) || {}).score);
        if (Number.isNaN(banNha) || Number.isNaN(banKhach)) continue;
        const cuaThang = banNha > banKhach ? 0 : banNha === banKhach ? 1 : 2;
        const p = t.moc.length >= 2 ? phanTichTran(t) : null;
        const kq = {
          id: t.id, giai: t.giai, nha: t.nha, khach: t.khach, gioDa: t.gioDa, tySo: `${banNha}-${banKhach}`, cuaThang,
          cuaDoTien: p && p.giam > 0 ? p.cua : null, doiDuocDoTien: p && p.giam > 0 ? p.doiDuocDoTien : null,
          giam: p ? +p.giam.toFixed(1) : 0, soGiam: p ? p.soGiam : 0, soSoSanh: p ? p.soSoSanh : 0,
          hinhDang: p ? p.hinhDang : null, duTieuChuan: !!(p && p.duTieuChuanTop),
        };
        kq.dungHuong = kq.cuaDoTien === null ? null : kq.cuaDoTien === cuaThang;
        ketQua.tran.unshift(kq);
        vuaXong.push(kq);
        // Cộng dồn thống kê theo mức kèo chạy (chỉ trận đủ tiêu chuẩn)
        if (kq.duTieuChuan && kq.giam >= CHI_DOI_CHIEU_TRAN_KEO_GIAM_TU_PHAN_TRAM) {
          const nhom = kq.giam >= 40 ? 'tu40' : kq.giam >= 30 ? 'tu30' : 'tu20';
          const tk = ketQua.thongKe[nhom] ||= { tong: 0, dung: 0 };
          tk.tong++; if (kq.dungHuong) tk.dung++;
        }
        delete lichSu.tran[ev.id];
        coThayDoi = true;
      }
    } catch (e) { console.log(`Lấy tỷ số ${ma}: ${e.message}`); }
  }
  ketQua.tran = ketQua.tran.slice(0, 300);
  // Quá lâu không có tỷ số thì bỏ
  for (const id in lichSu.tran) if (lichSu.tran[id].gioDa < bayGio - BO_TRAN_KHONG_CO_KET_QUA_SAU_SO_GIO * 3600e3) delete lichSu.tran[id];
  for (const k in trangThai.daBao) if (!lichSu.tran[k.split('|')[0]]) delete trangThai.daBao[k];
  for (const k in trangThai.daLayMoc) if (bayGio - trangThai.daLayMoc[k] > 24 * 3600e3) delete trangThai.daLayMoc[k];

  // Gửi Telegram kết quả đối chiếu (chỉ trận có kèo chạy)
  const canBao = vuaXong.filter(k => k.duTieuChuan && k.giam >= CHI_DOI_CHIEU_TRAN_KEO_GIAM_TU_PHAN_TRAM).sort((a, b) => b.giam - a.giam);
  if (canBao.length) {
    let nd = `🏁 <b>KẾT QUẢ ĐỐI CHIẾU</b>\n`;
    for (const k of canBao) {
      nd += `\n<b>${k.nha} ${k.tySo} ${k.khach}</b>\n   ${k.giai}\n` +
        `   💰 Tiền đổ vào: ${k.doiDuocDoTien} (−${k.giam}%) → ${k.dungHuong ? '✅ ĐÚNG HƯỚNG' : '❌ SAI HƯỚNG'}\n`;
    }
    const tk = ketQua.thongKe;
    const dong = (ten, x) => x && x.tong ? `${ten}: đúng ${x.dung}/${x.tong} trận (${Math.round(x.dung / x.tong * 100)}%)\n` : '';
    nd += `\n📈 <b>Thống kê cộng dồn</b>\n` + dong('Kèo giảm từ 40%', tk.tu40) + dong('Kèo giảm 30–40%', tk.tu30) + dong('Kèo giảm 20–30%', tk.tu20);
    await guiTelegram(nd);
  }

  // 6. Bản tin Top 5 mỗi 3 giờ (cho phép sớm 15 phút vì lịch chạy của GitHub hay bị trễ)
  if (bayGio - (trangThai.lanGuiBanTin || 0) >= GUI_BAN_TIN_TOP5_MOI_SO_GIO * 3600e3 - 15 * 60e3) {
    if (await guiBanTinTop5(lichSu, trangThai, bayGio)) { trangThai.lanGuiBanTin = bayGio; coThayDoi = true; }
  }

  // Chỉ lưu khi có thay đổi, tránh tạo bản lưu thừa mỗi 10 phút
  if (coThayDoi) {
    lichSu.capNhat = bayGio;
    trangThai.capNhat = bayGio;
    ghiFile(FILE_LICH_SU, lichSu);
    ghiFile(FILE_TRANG_THAI, trangThai);
    ghiFile(FILE_KET_QUA, ketQua);
  }
  console.log(`Xong. Giải có trận trong 24 giờ: ${giaiCanLay.map(g => g.ten).join(', ') || 'không có'}. Lượt còn lại: ${trangThai.conLai}`);
}

await chay();
