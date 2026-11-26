// Cấu hình mặc định của Đất Thủ Voice AI.
// Trước khi triển khai cho cả công ty: điền DEFAULT_CLIENT_ID để nhân viên không phải tự nhập.
// Mỗi lần sửa code: tăng APP_VERSION và VERSION trong service-worker.js (cùng một số).

export const APP_VERSION = '1.0.0';

export const DEFAULT_CLIENT_ID = '';
export const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app';

export const DRIVE_FOLDER_NAME = 'DatThu_Meeting_Records';
// drive.file: ứng dụng chỉ thấy và sửa các file/thư mục do chính nó tạo. Không cần Google thẩm định ứng dụng.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Cứ 10 giây ghi một đoạn âm thanh xuống bộ nhớ máy: app bị đóng đột ngột chỉ mất tối đa 10 giây.
export const RECORD_TIMESLICE_MS = 10000;
// 32 kbps mono: đủ rõ cho giọng nói, khoảng 14–15 MB mỗi giờ.
export const AUDIO_BITS_PER_SECOND = 32000;
// Mỗi lần gửi 4 MiB (Drive yêu cầu bội số của 256 KiB). Mất mạng chỉ phải gửi lại đoạn đang dở.
export const UPLOAD_CHUNK_BYTES = 16 * 256 * 1024;

// Nhắc khi bản ghi dài hơn giới hạn âm thanh của gói Gemini đang dùng.
export const DEFAULT_WARN_MINUTES = 180;
// Số bản ghi đã lên Drive được giữ trong danh sách "Đã lưu gần đây".
export const KEEP_UPLOADED_HISTORY = 10;

// Biến được tự điền khi sao chép: {TEN_FILE} {NGAY_GIO} {THOI_LUONG} {THU_MUC}
export const DEFAULT_TEMPLATES = [
  {
    id: 'bien-ban',
    name: 'BIÊN BẢN HỌP',
    text: `BIÊN BẢN HỌP
Bạn là thư ký cuộc họp của Công ty CP Kiến trúc & Xây dựng Đất Thủ.
Hãy nghe tệp ghi âm tôi đính kèm ({TEN_FILE}, ghi lúc {NGAY_GIO}, dài {THOI_LUONG}) và lập BIÊN BẢN HỌP bằng tiếng Việt, định dạng Markdown, gồm:
1. Thông tin chung: thời gian, người tham dự (nếu nghe được tên), người chủ trì.
2. Mục tiêu cuộc họp.
3. Nội dung thảo luận chính, gạch đầu dòng theo từng chủ đề, kèm mốc thời gian.
4. Quyết định đã chốt: mỗi quyết định một dòng, ghi rõ ai chốt.
5. Bảng phân công: | STT | Việc cần làm | Người phụ trách | Hạn hoàn thành | Tiêu chí hoàn thành |
6. Vấn đề còn bỏ ngỏ.
Quy tắc: chỉ ghi điều có trong ghi âm, không suy diễn. Chỗ nghe không rõ ghi [KHÔNG RÕ – hh:mm:ss]. Việc chưa có người, chưa có hạn hoặc chưa rõ tiêu chí thì ghi [CHƯA GIAO] / [CHƯA CÓ HẠN] / [CHƯA RÕ TIÊU CHÍ].`,
  },
  {
    id: 'nguyen-van',
    name: 'TRÍCH XUẤT NGUYÊN VĂN',
    text: `NGUYÊN VĂN
Hãy chép lại NGUYÊN VĂN toàn bộ hội thoại trong tệp ghi âm đính kèm ({TEN_FILE}, dài {THOI_LUONG}) bằng tiếng Việt.
Mỗi lượt nói một dòng theo mẫu:
[hh:mm:ss] Người nói X: nội dung
Quy tắc:
- Phân biệt người nói theo giọng. Nghe được tên thì dùng tên, không thì ghi "Người nói 1, 2…" và giữ nhất quán.
- Giữ nguyên từ ngữ, thuật ngữ xây dựng và số liệu. Không tóm tắt, không sửa câu.
- Chỗ nghe không rõ ghi [KHÔNG RÕ]; tiếng ồn ghi [ỒN]; im lặng trên 10 giây ghi [IM LẶNG].
- Ghi âm dài: chia thành nhiều phần, hết mỗi phần hỏi tôi "Tiếp tục?" rồi mới viết phần sau.`,
  },
  {
    id: 'chuyen-sau',
    name: 'CHUYÊN SÂU',
    text: `PHÂN TÍCH CHUYÊN SÂU
Bạn là chuyên gia quản trị dự án thiết kế & xây dựng nhà ở. Từ tệp ghi âm cuộc họp đính kèm ({TEN_FILE}, ghi lúc {NGAY_GIO}), hãy phân tích bằng tiếng Việt, định dạng Markdown:
1. Vấn đề tồn đọng: liệt kê từng vấn đề, kèm câu nói và mốc thời gian làm căn cứ.
2. Rủi ro: | Rủi ro | Khả năng (Cao/TB/Thấp) | Tác động (tiến độ, chi phí, chất lượng, an toàn, quan hệ khách hàng) | Dấu hiệu trong cuộc họp |
3. Đề xuất giải pháp: mỗi giải pháp nêu lợi ích, rủi ro, người nên phụ trách, việc làm trong 48 giờ tới.
4. Câu hỏi cần làm rõ ở cuộc họp sau.
Quy tắc: tách rõ điều nghe được trong ghi âm và điều bạn suy luận (ghi [SUY LUẬN]). Không đề xuất cắt giảm biện pháp an toàn, kết cấu hay vật liệu chịu lực để tiết kiệm chi phí.`,
  },
];
