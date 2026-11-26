# Đất Thủ Voice AI · Hướng dẫn triển khai

Ứng dụng web cài được như app (PWA) để ghi âm cuộc họp trên máy đọc sách BOOX 10.3". Ghi xong, app tự tải file lên Google Drive, thư mục `DatThu_Meeting_Records`, rồi mở Gemini để phân tích. Không có máy chủ trung gian và không tốn phí API.

Thời gian triển khai lần đầu: khoảng 45 phút, gồm 4 bước: lấy Client ID → đưa app lên mạng → cài lên BOOX → tạo Gem.

---

## 0. Đọc trước: 4 giới hạn đã biết

| # | Giới hạn | Ảnh hưởng | Cách xử lý |
|---|---|---|---|
| 1 | **Gemini app giới hạn độ dài âm thanh:** gói miễn phí tổng cộng **10 phút** mỗi lần hỏi; Google AI Pro/Ultra **3 giờ**; mỗi file tối đa 100 MB (theo [9to5Google](https://9to5google.com/2025/09/08/gemini-audio-upload/) và [Android Authority](https://www.androidauthority.com/gemini-audio-uploads-3595927/), 09/2025). Chưa đối chiếu được với [trang trợ giúp chính thức](https://support.google.com/gemini/answer/14903178), cần kiểm lại. | Cuộc họp 60 phút **không phân tích được** bằng tài khoản Gemini miễn phí. | Dùng tài khoản có Google AI Pro, hoặc Google Workspace có Gemini. Trong CÀI ĐẶT đặt "Nhắc khi ghi quá" bằng giới hạn gói đang dùng. |
| 2 | **Định dạng file:** Gemini nhận MP3, M4A, WAV. Chưa có nguồn xác nhận Gemini app nhận WebM. | Nếu máy chỉ ghi được WebM, Gemini có thể từ chối file. | App tự ưu tiên **M4A** khi máy ghi được (CÀI ĐẶT hiện dòng "Máy này ghi được: M4A CÓ/KHÔNG"). Bắt buộc chạy bài kiểm tra 5.2 trước khi dùng thật. |
| 3 | **Quyền `drive.file`:** app chỉ thấy file và thư mục do chính nó tạo. | Nếu bạn tự tạo tay thư mục `DatThu_Meeting_Records` trước, app sẽ tạo thêm một thư mục trùng tên. | Để app tự tạo thư mục. Đổi lại, Google không bắt thẩm định ứng dụng, và app không đọc được file nào khác trong Drive. |
| 4 | **Phiên đăng nhập Google sống khoảng 1 giờ.** | Sau 1 giờ, lúc bấm KẾT THÚC & LƯU DRIVE, cửa sổ Google có thể hiện lên vài giây để xin lại quyền. | Không cần làm gì. Nếu xin không được, bản ghi vẫn nằm trong máy, chờ bấm KẾT NỐI LẠI & TẢI LÊN. |

---

## 1. Lấy Google Client ID miễn phí

Cần một tài khoản Google, tốt nhất là tài khoản quản trị Google Workspace `@datthu.vn`. Không cần thẻ thanh toán.

**Bước 1. Tạo dự án**
1. Vào https://console.cloud.google.com → đăng nhập.
2. Thanh trên cùng: bấm ô chọn dự án → **New Project**.
3. Đặt tên `datthu-voice-ai` → **Create**. Chờ khoảng 30 giây, rồi chọn đúng dự án vừa tạo.

**Bước 2. Bật Google Drive API**
1. Menu ☰ → **APIs & Services** → **Library**.
2. Tìm `Google Drive API` → bấm vào → **Enable**.

**Bước 3. Màn hình xin quyền (OAuth consent)**
Mục này nằm trong **Google Auth Platform**. Ở giao diện cũ, nó tên là **OAuth consent screen**.
1. Menu ☰ → **APIs & Services** → **OAuth consent screen** (hoặc **Google Auth Platform**) → **Get started**.
2. **App information:** App name `Đất Thủ Voice AI`; User support email: email của bạn.
3. **Audience:**
   - Email công ty chạy trên Google Workspace `@datthu.vn`: chọn **Internal**. Chỉ tài khoản công ty đăng nhập được, không cần thêm danh sách người dùng.
   - Dùng Gmail cá nhân: chọn **External**. Sau đó vào mục **Audience** → **Test users** → **Add users**, thêm email từng người dùng (tối đa 100 người).
4. **Contact information:** nhập email → đồng ý điều khoản → **Create**.
5. Mục **Data Access** → **Add or remove scopes** → tìm và tích `.../auth/drive.file` → **Update** → **Save**.

**Bước 4. Tạo Client ID**
1. Mục **Clients** (hoặc **APIs & Services → Credentials → Create credentials → OAuth client ID**).
2. Application type: **Web application**. Name: `DatThu Voice AI Web`.
3. **Authorized JavaScript origins** → **Add URI**, nhập địa chỉ gốc nơi app chạy. Chỉ ghi tên miền, **không ghi đường dẫn, không có dấu `/` ở cuối**:
   - GitHub Pages: `https://sangtran-create.github.io`
   - Vercel: `https://ten-du-an.vercel.app` (lấy ở bước 2.2)
   - Thử trên máy tính: `http://localhost:8765`
4. Bỏ trống **Authorized redirect URIs** → **Create**.
5. Sao chép **Client ID**, có dạng `1234567890-abc...xyz.apps.googleusercontent.com`.

> Client ID không phải mật khẩu. Nó nằm công khai trong trang web là bình thường. App **không dùng Client Secret**, đừng dán Client Secret vào đâu cả.

**Bước 5. Đưa Client ID vào app.** Chọn một trong hai cách:
- **Cho cả công ty (khuyên dùng):** mở `js/config.js`, điền `export const DEFAULT_CLIENT_ID = '...';` rồi đưa lên mạng (bước 2). Nhân viên mở app là dùng được ngay.
- **Từng máy:** mở app → **CÀI ĐẶT** → dán vào ô *Google Client ID* → **LƯU CÀI ĐẶT**.

---

## 2. Đưa app lên mạng miễn phí

App bắt buộc chạy qua `https://`, vì trình duyệt chỉ cho ghi âm và cài PWA trên trang bảo mật. Chọn **một** trong hai cách.

### 2.1. GitHub Pages (code đang nằm sẵn trong repo `sangtran-viet`)

1. Vào `https://github.com/sangtran-create/sangtran-viet` → **Settings** → **Pages**.
2. **Source:** *Deploy from a branch* → Branch `main`, thư mục `/ (root)` → **Save**.
3. Chờ 1–3 phút. App chạy ở: `https://sangtran-create.github.io/sangtran-viet/datthu-voice-ai/`
4. Thêm `https://sangtran-create.github.io` vào **Authorized JavaScript origins** (bước 1.4).

Lưu ý:
- Cách này xuất bản **cả repo**, gồm trang blog ở thư mục gốc. Muốn tách riêng thì tạo repo mới `datthu-voice-ai`, chép nội dung thư mục này vào, rồi bật Pages cho repo đó. Địa chỉ app khi đó là `https://sangtran-create.github.io/datthu-voice-ai/`.
- Repo riêng tư (private) chỉ bật được Pages khi dùng gói GitHub trả phí.

### 2.2. Vercel

1. Vào https://vercel.com → đăng nhập bằng GitHub.
2. **Add New → Project** → chọn repo `sangtran-viet` → **Import**.
3. **Root Directory:** bấm *Edit* → chọn `datthu-voice-ai`. **Framework Preset:** *Other*. Để trống Build Command và Output Directory.
4. **Deploy.** Bạn nhận địa chỉ dạng `https://datthu-voice-ai.vercel.app`.
5. Thêm địa chỉ đó vào **Authorized JavaScript origins** (bước 1.4).

File `vercel.json` đã đặt sẵn để trình duyệt luôn kiểm tra bản mới của service worker.

### 2.3. Khi sửa code về sau

Mỗi lần sửa, tăng số phiên bản ở **hai chỗ, giống nhau**: `APP_VERSION` trong `js/config.js` và `VERSION` trong `service-worker.js`, ví dụ `1.0.0` → `1.0.1`. Máy đã cài sẽ hiện thanh **CÓ BẢN CẬP NHẬT MỚI → CẬP NHẬT NGAY**. App không bao giờ tự tải lại khi đang ghi âm hoặc đang tải lên.

---

## 3. Cài lên BOOX 10.3"

1. Mở **Google Chrome** trên BOOX. Máy chưa có Chrome thì bật Google Play trong cài đặt ứng dụng của BOOX rồi cài Chrome.
2. Vào địa chỉ app ở bước 2 → menu **⋮** → **Cài đặt ứng dụng** / **Thêm vào màn hình chính**.
3. Mở app từ biểu tượng micro đen. App chạy toàn màn hình, không có thanh địa chỉ.
4. Lần đầu bấm **BẮT ĐẦU GHI ÂM**, máy hỏi quyền micro → **Cho phép**.
5. Bấm **KẾT NỐI GOOGLE DRIVE** → chọn tài khoản → tích ô quyền Drive → **Tiếp tục**.

Cài đặt BOOX nên chỉnh. Tên mục khác nhau theo đời máy và phiên bản phần mềm:
- **Không cho hệ thống đóng băng (freeze) Chrome khi chạy nền.** BOOX có cơ chế tiết kiệm pin đóng ứng dụng nền, có thể làm ngắt ghi âm khi bạn chuyển sang ứng dụng khác.
- **Tự tắt màn hình / tự ngủ:** để từ 30 phút trở lên làm dự phòng. App đã xin giữ sáng màn hình khi ghi; dòng **MÀN HÌNH** cho biết việc xin có thành công không.
- **Chế độ làm mới E-Ink cho Chrome:** chọn *Normal* hoặc *HD*. Chế độ *Fast/A2* dễ để lại bóng mờ trên chữ to.
- Khi ghi, **để app ở màn hình chính**, không chuyển sang ứng dụng khác.

---

## 4. Tạo Gem trên Gemini (chuẩn hóa đầu ra Markdown / Google Docs / PDF)

1. Vào https://gemini.google.com → thanh bên trái → **Khám phá Gem** (Explore Gems) → **Gem mới** (New Gem).
2. **Tên:** `Đất Thủ · Thư ký cuộc họp`.
3. Dán toàn bộ khối dưới đây vào ô **Hướng dẫn** (Instructions) → **Lưu**.
4. Mở Gem vừa tạo → sao chép đường dẫn trên thanh địa chỉ (dạng `https://gemini.google.com/gem/...`) → dán vào app: **CÀI ĐẶT → Đường dẫn Gemini hoặc Gem**.

```text
# VAI TRÒ
Bạn là Thư ký và Chuyên viên phân tích cuộc họp của Công ty CP Kiến trúc & Xây dựng Đất Thủ (thiết kế và xây dựng nhà ở trung–cao cấp tại Bình Dương, TP.HCM).
Đầu vào: một tệp ghi âm cuộc họp tiếng Việt (m4a, webm, mp3) đính kèm từ Google Drive, cùng một câu lệnh mở đầu bằng tên chế độ.

# CHỌN CHẾ ĐỘ
- Câu lệnh mở đầu "BIÊN BẢN HỌP" → MẪU A.
- Câu lệnh mở đầu "NGUYÊN VĂN" → MẪU B.
- Câu lệnh mở đầu "PHÂN TÍCH CHUYÊN SÂU" → MẪU C.
- Không có tệp ghi âm đính kèm → nhắc: "Bấm dấu (+) → Drive → thư mục DatThu_Meeting_Records → chọn file." Không tự bịa nội dung.
- Không rõ chế độ → hỏi lại đúng 1 câu.

# NGUYÊN TẮC BẮT BUỘC
1. Chỉ dùng điều có trong ghi âm. Không bịa tên người, số liệu, ngày, cam kết.
2. Nghe không rõ: ghi [KHÔNG RÕ – hh:mm:ss]. Điều bạn suy luận: ghi [SUY LUẬN].
3. Số giữ nguyên đơn vị: m², m³, triệu đồng, ngày, %.
4. Người nói: dùng tên nếu nghe được; không thì "Người nói 1, 2…" và giữ nhất quán trong cả tài liệu.
5. Giữ đúng thuật ngữ ngành: móng, cọc, dầm, sàn, cột, BTCT, BOQ, dự toán, phát sinh, nghiệm thu, bản vẽ thi công, shop drawing, tiến độ, tạm ứng, bảo hành, chủ đầu tư, gia chủ, KTS, giám sát, thầu phụ.
6. Không đề xuất cắt giảm biện pháp an toàn, kết cấu, vật liệu chịu lực để tiết kiệm chi phí.
7. Cuộc họp có nói về giá vốn, biên lợi nhuận, báo giá nhà thầu: thêm "(NỘI BỘ – KHÔNG GỬI KHÁCH HÀNG)" ngay dưới tiêu đề.
8. Viết tiếng Việt, câu ngắn, rõ ai làm gì. Không khen, không rào đón.

# ĐỊNH DẠNG ĐẦU RA (để xuất Google Docs và PDF sạch)
- Markdown chuẩn: "#" cho tiêu đề tài liệu, "##" cho mục, "###" cho mục con.
- Bảng Markdown đơn giản: không gộp ô, không xuống dòng trong ô, tối đa 6 cột.
- Không emoji, không HTML, không khối code.
- Dòng ngay dưới tiêu đề: "Tệp: … · Ngày họp: … · Thời lượng: …".
- Mục cuối luôn là "## Ghi chú độ tin cậy": số chỗ [KHÔNG RÕ], đoạn âm thanh kém, điều cần người dự họp xác nhận.
- Dòng cuối cùng: "Bản nháp do AI tạo. Người chủ trì đọc lại trước khi gửi."

# MẪU A – BIÊN BẢN HỌP
# BIÊN BẢN HỌP – <chủ đề chính>
## 1. Thông tin chung
| Mục | Nội dung |  (Thời gian · Địa điểm · Chủ trì · Thành phần · Thư ký: bản nháp AI)
## 2. Mục tiêu cuộc họp
## 3. Nội dung thảo luận
Chia theo chủ đề; mỗi ý có mốc [hh:mm:ss].
## 4. Quyết định đã chốt
| STT | Quyết định | Người chốt | Mốc ghi âm |
## 5. Phân công công việc
| STT | Việc cần làm | Người phụ trách | Hạn | Tiêu chí hoàn thành |
Thiếu thông tin thì ghi [CHƯA GIAO] / [CHƯA CÓ HẠN] / [CHƯA RÕ TIÊU CHÍ]. Không tự điền.
## 6. Vấn đề còn mở
## 7. Ghi chú độ tin cậy

# MẪU B – NGUYÊN VĂN
# BẢN GHI NGUYÊN VĂN – <tên tệp>
Mỗi lượt nói một dòng: [hh:mm:ss] Người nói X: nội dung
Giữ nguyên từ ngữ, kể cả từ địa phương và số liệu. Không tóm tắt, không sửa câu. [ỒN] cho tiếng ồn; [IM LẶNG] cho im lặng trên 10 giây.
Ghi âm dài: chia phần, hết mỗi phần hỏi "Tiếp tục?".

# MẪU C – PHÂN TÍCH CHUYÊN SÂU
# PHÂN TÍCH CUỘC HỌP – <chủ đề chính>
## 1. Tóm tắt 3 dòng
## 2. Vấn đề tồn đọng
Mỗi vấn đề: mô tả · căn cứ (trích câu nói + mốc thời gian) · đã tồn bao lâu (nếu nghe được).
## 3. Rủi ro
| Rủi ro | Khả năng (Cao/TB/Thấp) | Tác động (tiến độ / chi phí / chất lượng / an toàn / quan hệ khách hàng) | Dấu hiệu trong cuộc họp |
## 4. Đề xuất giải pháp
Mỗi giải pháp: lợi ích · rủi ro · người nên phụ trách · việc làm trong 48 giờ · cách đo đã xong.
## 5. Câu hỏi cho cuộc họp sau
## 6. Ghi chú độ tin cậy

# XUẤT FILE
- Người dùng gõ "XUẤT DOCS": nhắc bấm nút Chia sẻ & xuất (biểu tượng chia sẻ dưới câu trả lời) → Xuất sang Google Tài liệu.
- Người dùng gõ "XUẤT PDF": nhắc xuất sang Google Tài liệu trước, rồi trong Docs chọn Tệp → Tải xuống → PDF.
```

Cách dùng hằng ngày: ghi xong → bấm **PHÂN TÍCH: …** → Gemini (hoặc Gem) mở ra → bấm **(+)** → **Drive** → mở thư mục `DatThu_Meeting_Records` → chọn file có tên app vừa báo → dán lệnh (giữ tay vào ô nhập → **Dán**) → gửi.

Gemini chỉ thêm được file từ Drive khi tài khoản đã bật *Hoạt động trên các ứng dụng Gemini* (Gemini Apps Activity) và đã kết nối Google Workspace với Gemini. Chưa bật thì Gemini sẽ hỏi bật ở lần đầu.

---

## 5. Nghiệm thu: tiêu chuẩn đầu ra

Chạy đủ 7 bài trên chính máy BOOX sẽ dùng thật. Ghi kết quả ĐẠT / KHÔNG ĐẠT vào cột cuối.

| # | Bài kiểm tra | Đạt khi | Kết quả |
|---|---|---|---|
| 5.1 | Cài app (mục 3) | Biểu tượng micro đen trên màn hình chính; mở ra không có thanh địa chỉ | |
| 5.2 | **Gemini nhận file.** Ghi 1 phút → lưu → bấm PHÂN TÍCH: BIÊN BẢN HỌP → đính kèm file trong Gemini | Gemini đọc được nội dung tiếng Việt, ra đủ 7 mục của Mẫu A. **Không đạt thì dừng triển khai**, xem mục 6 dòng "Gemini không nhận file" | |
| 5.3 | Ghi 60 phút liên tục, máy để yên | Màn hình không tắt; thời lượng trên app = 01:00:00 ± 5 giây; dung lượng khoảng 13–16 MB | |
| 5.4 | Đang ghi thì bật chế độ máy bay → bấm KẾT THÚC & LƯU DRIVE → tắt chế độ máy bay | Bản ghi nằm trong "CHƯA LÊN DRIVE", rồi tự lên Drive trong vòng 1 phút sau khi có mạng | |
| 5.5 | Đang ghi thì tắt hẳn app (vuốt đóng) → mở lại | Hiện bản ghi "Đã khôi phục phần ghi được", mất tối đa 10 giây cuối | |
| 5.6 | Để app 70 phút sau khi kết nối Drive → ghi 1 phút → lưu | Cửa sổ Google hiện lên rồi tự đóng; file lên Drive, không mất | |
| 5.7 | Mở Drive trên máy tính | File đúng tên `DatThu_YYYY-MM-DD_HH-mm.m4a` (hoặc `.webm`), nằm trong `DatThu_Meeting_Records` | |

Đã kiểm trên Chromium (Playwright, micro giả, Google giả lập): 32/32 bài đạt, gồm ghi/tạm dừng/tiếp tục, tên file, tải lên từng đoạn 4 MiB khi đứt kết nối giữa chừng, mất mạng rồi tự tải lại, phiên Google hết hạn, khôi phục sau khi app bị đóng, mở app khi mất mạng, và soát toàn trang chỉ dùng hai màu `#000000`/`#FFFFFF`. **Chưa kiểm trên BOOX thật và Google thật.** Đó là việc của bảng trên.

---

## 6. Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Cửa sổ Google báo `Error 400: origin_mismatch` hoặc `redirect_uri_mismatch` | Địa chỉ app chưa có trong *Authorized JavaScript origins* | Thêm đúng tên miền (mục 1, bước 4.3), chờ 5 phút rồi thử lại |
| `Error 403: access_denied` | Ứng dụng External đang ở chế độ thử nghiệm, email chưa nằm trong Test users | Thêm email vào Test users, hoặc chuyển sang Internal nếu dùng Workspace |
| Bấm KẾT NỐI không có gì xảy ra | Trình duyệt chặn cửa sổ bật lên, hoặc thư viện Google chưa tải xong | Cho phép pop-up cho trang; chờ vài giây rồi bấm lại. App đã cài mà vẫn lỗi: mở địa chỉ app bằng tab Chrome thường, kết nối ở đó (app đã cài và tab Chrome dùng chung dữ liệu đăng nhập) |
| "Bạn chưa tích ô cho phép ứng dụng dùng Google Drive" | Bỏ qua ô quyền Drive ở màn hình xin quyền | Bấm kết nối lại, tích ô quyền Drive |
| "Chưa cho phép dùng micro" | Đã từ chối quyền micro | Cài đặt Android → Ứng dụng → Chrome (hoặc Đất Thủ Voice AI) → Quyền → Micro → Cho phép |
| Dòng MÀN HÌNH báo "KHÔNG GIỮ SÁNG ĐƯỢC" | Máy hoặc trình duyệt không hỗ trợ Wake Lock | Đặt giờ tự tắt màn hình của BOOX ≥ 30 phút trước khi họp |
| Gemini không nhận file | Gemini app không nhận định dạng WebM, hoặc file dài quá giới hạn gói | Xem CÀI ĐẶT → "Máy này ghi được: M4A …". M4A = KHÔNG: cập nhật Chrome lên bản mới nhất rồi xem lại. Vẫn không được: báo lại để bổ sung bộ mã hóa MP3 vào app |
| "Google Drive đã hết dung lượng" | Drive đầy | Dọn Drive rồi bấm TẢI LÊN; bản ghi vẫn nằm trong máy |
| Hai file trùng tên | Ghi hai lần trong cùng một phút | Drive vẫn giữ cả hai; chọn theo giờ tải lên |

---

## 7. Dữ liệu và quyền riêng tư

- **Báo người dự họp trước khi ghi âm.** Giọng nói là dữ liệu cá nhân theo Nghị định 13/2023/NĐ-CP và Luật Bảo vệ dữ liệu cá nhân (hiệu lực từ 01/01/2026). Cách xin đồng ý (nói đầu buổi, ghi trong thư mời) cần người phụ trách pháp chế xác nhận.
- **Dùng tài khoản Google công ty `@datthu.vn`** cho cuộc họp có giá vốn, biên lợi nhuận, báo giá nhà thầu, thông tin khách hàng. Theo chính sách Google công bố, Gemini trong Google Workspace không dùng nội dung để huấn luyện mô hình; tài khoản Gmail cá nhân có thể bị người của Google xem lại hội thoại khi bật Gemini Apps Activity. Chính sách thay đổi theo thời gian: quản trị Workspace cần kiểm lại trong Admin console trước khi dùng.
- App chỉ có quyền `drive.file`, nên **không đọc được** các file khác trong Drive. Bản ghi tạm trong máy bị xóa ngay sau khi Drive xác nhận đủ dung lượng.
- Mất máy BOOX: vào https://myaccount.google.com/permissions → gỡ quyền "Đất Thủ Voice AI".

---

## 8. Cấu trúc mã nguồn

```text
datthu-voice-ai/
├── index.html            Giao diện
├── manifest.json         Khai báo PWA (tên, biểu tượng, chạy toàn màn hình)
├── service-worker.js     Lưu sẵn giao diện để mở được khi mất mạng
├── vercel.json           Cấu hình cho Vercel
├── css/style.css         Chuẩn E-Ink: đen/trắng, không chuyển động, nút ≥ 56px
├── icons/                Biểu tượng 192, 512, maskable, SVG
└── js/
    ├── config.js         Client ID mặc định, tên thư mục, 3 mẫu lệnh, bitrate
    ├── app.js            Điều phối giao diện và luồng ghi → lưu → tải → phân tích
    ├── recorder.js       Ghi âm (MediaRecorder), mỗi 10 giây lưu một đoạn xuống máy
    ├── storage.js        Kho IndexedDB: bản ghi chờ tải, khôi phục khi app bị đóng
    ├── drive.js          Drive API: tìm/tạo thư mục, tải lên từng đoạn, kiểm dung lượng
    ├── auth.js           Đăng nhập Google (Google Identity Services, không cần máy chủ)
    ├── settings.js       Lưu và kiểm tra cài đặt, điền biến vào mẫu lệnh
    └── wakelock.js       Giữ màn hình sáng khi ghi
```

Thông số chính, chỉnh trong `js/config.js`:
- Âm thanh mono 32 kbps, khoảng 14–15 MB mỗi giờ. Tăng `AUDIO_BITS_PER_SECOND` lên 64000 nếu phòng họp ồn và Gemini nghe kém; file sẽ to gấp đôi.
- Mỗi 10 giây ghi một đoạn xuống máy (`RECORD_TIMESLICE_MS`).
- Tải lên từng đoạn 4 MiB, tự thử lại 6 lần khi mạng chập chờn rồi mới chuyển sang hàng chờ.

Thử trên máy tính: trong thư mục `datthu-voice-ai`, chạy `python3 -m http.server 8765`, mở `http://localhost:8765` bằng Chrome, và nhớ thêm `http://localhost:8765` vào Authorized JavaScript origins.
