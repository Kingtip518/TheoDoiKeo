// =====================================================================
//  PHÂN TÍCH KÈO 1 TRẬN – dùng chung cho máy lấy kèo và trang web
// =====================================================================

export const TEN_CUA = ['Đội nhà thắng', 'Hòa', 'Đội khách thắng'];

// ---------------- CÀI ĐẶT (sửa số ở đây nếu muốn) ----------------
export const CAI_DAT = {
  KEO_BAT_THUONG_KHI_GIAM_TU_PHAN_TRAM: 20,       // giá giảm từ 20% trở lên mới coi là bất thường (vào Top 5, báo Telegram, thống kê)
  NHA_CAI_COI_LA_GIAM_KHI_GIAM_TU_PHAN_TRAM: 10,  // 1 nhà cái giảm từ 10% mới tính là "cùng giảm"
  VAO_TOP5_KHI_TI_LE_NHA_CAI_CUNG_GIAM_TU: 0.6,   // ít nhất 60% số nhà cái cùng giảm mới vào Top 5
  COI_LA_NHAY_DOT_NGOT_KHI_1_LAN_CHIEM_TU: 0.7,   // 1 lần lấy chiếm từ 70% tổng mức giảm = nhảy đột ngột
  DOI_CUA_DUOI_KHI_GIA_DAU_TU: 2.6,               // đội có giá từ 2.6 trở lên coi là đội cửa dưới
  SAT_GIO_DA_KHI_CON_DUOI_SO_GIO: 6,
};
// ------------------------------------------------------------------

const phanTramDoi = (dau, moi) => (moi - dau) / dau * 100;

// t: dữ liệu 1 trận. tuLuc: chỉ xét từ thời điểm này (bỏ trống = từ lần lấy đầu tiên)
export function phanTichTran(t, tuLuc) {
  const ds = tuLuc ? t.moc.filter(m => m.luc >= tuLuc) : t.moc;
  if (ds.length < 2) return null;
  const dau = ds[0], moi = ds[ds.length - 1];

  // Tính theo giá trung bình của tất cả nhà cái (cả thị trường)
  const pt = [0, 1, 2].map(i => phanTramDoi(dau.tb[i], moi.tb[i]));
  const cua = pt.indexOf(Math.min(...pt));                         // cửa được đổ tiền
  const cuaBo = cua === 1 ? (pt[0] >= pt[2] ? 0 : 2) : (cua === 0 ? 2 : 0); // cửa bị bỏ
  const tenDoi = [t.nha, 'Hòa', t.khach];

  // Bao nhiêu nhà cái cùng giảm cửa đó (so với giá đầu tiên của chính nhà cái đó)
  let soGiam = 0, soSoSanh = 0;
  if (!tuLuc) {
    for (const k in t.ncMoi) {
      const c = t.ncDau[k]; if (!c) continue;
      soSoSanh++;
      if (phanTramDoi(c[cua], t.ncMoi[k][cua]) <= -CAI_DAT.NHA_CAI_COI_LA_GIAM_KHI_GIAM_TU_PHAN_TRAM) soGiam++;
    }
  }

  // Pinnacle (nhà cái chuyên nghiệp) có giảm theo không
  const pinDau = ds.find(m => m.pin);
  const pinGiam = pinDau && moi.pin ? -phanTramDoi(pinDau.pin[cua], moi.pin[cua]) : null;

  // Hình dạng: giảm từ từ hay nhảy đột ngột
  const chuoi = ds.map(m => m.tb[cua]);
  const tongGiam = chuoi[0] - chuoi[chuoi.length - 1];
  let buocLonNhat = 0, soLanGiam = 0;
  for (let i = 1; i < chuoi.length; i++) {
    const g = chuoi[i - 1] - chuoi[i];
    if (g > 0) { soLanGiam++; buocLonNhat = Math.max(buocLonNhat, g); }
  }
  let hinhDang = 'chua-ro';
  if (chuoi.length >= 3 && tongGiam > 0)
    hinhDang = buocLonNhat / tongGiam >= CAI_DAT.COI_LA_NHAY_DOT_NGOT_KHI_1_LAN_CHIEM_TU ? 'dot-ngot' : 'tu-tu';

  // Nghi dữ liệu đảo đội: 2 cửa thắng gần như đổi chỗ, hòa đứng yên, và không phải giảm từ từ
  const gan = (a, b) => Math.abs(a - b) / b < 0.12;
  const nghiDaoDoi = hinhDang !== 'tu-tu' && Math.abs(pt[0]) > 30 &&
    gan(moi.tb[0], dau.tb[2]) && gan(moi.tb[2], dau.tb[0]) && Math.abs(pt[1]) < 3;

  const duNhaCaiCungGiam = soSoSanh < 3 || soGiam / soSoSanh >= CAI_DAT.VAO_TOP5_KHI_TI_LE_NHA_CAI_CUNG_GIAM_TU;

  return {
    cua, cuaBo,
    doiDuocDoTien: cua === 1 ? 'Cửa hòa' : tenDoi[cua],
    doiBiBo: tenDoi[cuaBo],
    giam: -pt[cua], giaDau: dau.tb[cua], giaMoi: moi.tb[cua],
    tangBo: pt[cuaBo], giaBoDau: dau.tb[cuaBo], giaBoMoi: moi.tb[cuaBo],
    soGiam, soSoSanh, pinGiam,
    hinhDang, soLanLay: ds.length, soLanGiam,
    doiCuaDuoi: cua !== 1 && dau.tb[cua] >= CAI_DAT.DOI_CUA_DUOI_KHI_GIA_DAU_TU,
    satGioDa: t.gioDa - moi.luc < CAI_DAT.SAT_GIO_DA_KHI_CON_DUOI_SO_GIO * 3600e3,
    nghiDaoDoi,
    duTieuChuanTop: !nghiDaoDoi && duNhaCaiCungGiam && -pt[cua] >= CAI_DAT.KEO_BAT_THUONG_KHI_GIAM_TU_PHAN_TRAM,
    tuLuc: dau.luc,
  };
}

export function moTaHinhDang(p) {
  if (p.hinhDang === 'tu-tu') return `Giảm từ từ (${p.soLanGiam}/${p.soLanLay - 1} lần lấy đều giảm)`;
  if (p.hinhDang === 'dot-ngot') return 'Nhảy đột ngột trong 1 lần';
  return 'Mới có 2 lần lấy, chưa rõ giảm từ từ hay đột ngột';
}

export function moTaPinnacle(p) {
  if (p.pinGiam === null) return 'Pinnacle: không có giá';
  if (p.pinGiam >= 3) return `Pinnacle cũng giảm ${p.pinGiam.toFixed(1)}%`;
  return `Pinnacle KHÔNG giảm theo (${p.pinGiam >= 0 ? '−' : '+'}${Math.abs(p.pinGiam).toFixed(1)}%)`;
}
