# Vietflex Sáp nhập · WebGIS ĐVHC Việt Nam sau 2025

WebGIS tĩnh dành cho GitHub Pages để tra cứu **34 tỉnh/thành** và **3.321 đơn vị cấp xã** (697 phường, 2.611 xã, 13 đặc khu), kèm so sánh biểu đồ diện tích, dân số và mật độ dân số.

## Kiến trúc

- **Map core/UI:** Vietflex `VN`, pin tại commit `6144d565fcf236727577ab3c4471bbe49f86892f`.
- **Ranh giới:** tái sử dụng PMTiles vector đã nhúng trong `Vietflexmap/anhmap`, pin snapshot `e80f4ee9f1e167817e4a9af8402c0bca4052573e`.
- **Dữ liệu thuộc tính:** `data/admin.json`, snapshot `2025-arrangement_snapshot-2026-09-08`, gồm 34 tỉnh/thành + 3.321 mã ĐVHC duy nhất.
- **Biểu đồ:** Chart.js 4.5.1.
- Không cần backend; chạy trực tiếp trên GitHub Pages.

> Lưu ý kỹ thuật: nguồn `anhmap` đang dùng **PMTiles**, không phải SQLite MBTiles. WebGIS tải snapshot HTML đã pin, tách `pmtilesData` + `adminData` trong trình duyệt và dùng PMTiles làm lớp ranh giới có thể click/truy vấn.

## Chức năng

Tra cứu theo tên/mã; lọc tỉnh/thành và loại đơn vị; click trực tiếp polygon; xem diện tích, dân số 2025, mật độ, trung tâm hành chính, nguồn sắp xếp; so sánh 2–8 tỉnh/thành hoặc 2–8 phường/xã/đặc khu bằng biểu đồ và bảng.

## Cập nhật dữ liệu

Giữ ổn định các khóa `id`, `code`, `province_order`, `province_name`, `area_km2`, `population_2025`. `density` được tính bằng `population_2025 / area_km2`. Thống kê cấp tỉnh hiện được tổng hợp từ toàn bộ đơn vị cấp xã trong từng tỉnh/thành.

## Nguồn / ghi công

Vietflex do Long Ngo phát triển. Ranh giới dùng lại từ `Vietflexmap/anhmap`. Dữ liệu thuộc tính chuyển đổi từ bộ bảng đơn vị hành chính sau sắp xếp do dự án tổng hợp từ `sapnhap.bando.com.vn`. Hãy kiểm tra văn bản pháp lý gốc trước khi dùng cho mục đích pháp lý/chuyên môn có tính quyết định.
