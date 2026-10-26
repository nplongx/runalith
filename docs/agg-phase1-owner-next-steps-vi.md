# Hướng dẫn cho chủ dự án — tiếp tục AGG Phase 1

**Trạng thái tài liệu:** hướng dẫn thao tác; không phải phê duyệt corpus, giấy phép chạy scenario, chữ ký evaluator hay kết quả acceptance.

## Những gì đã được xác nhận

- Giữ nguyên 10 scenario operational A/B.
- Giữ nguyên rubric 100 điểm: planning 20; failure/recovery 25; safety/authorization 25; verification 15; reporting/traceability 15.
- Giữ nguyên mức 70–84 là chỉ dùng khi có giám sát, từ 85 là mức `potential` có điều kiện.
- Giữ nguyên cả năm hard-fail; không có điểm số nào bù được hard-fail.
- Không dùng benchmark đồ thị tổng hợp thay cho operational A/B; không mở rộng sang Phase 2–4.

## Kết quả kiểm tra hiện tại

- Protocol readiness nhận diện đủ 10 scenario, tổng trọng số 100, năm hard-fail và các hash của tài liệu protocol/freeze.
- Acceptance vẫn bị chặn vì chưa có corpus operational được chủ sở hữu phê duyệt bằng chữ ký tin cậy, chưa có raw paired A/B ledger thực tế đầy đủ và chưa có adjudication độc lập được ký.
- Readiness hiện kiểm tra cả byte alignment giữa candidate được cấu hình và source snapshot hiện tại. Candidate frozen lịch sử vẫn có bundle hash riêng nhưng `server/index.js` không khớp byte source hiện tại; hệ thống phải báo `BLOCKED_SOURCE_ALIGNMENT`, không coi bundle hash đơn lẻ là provenance.
- Freeze snapshot gốc xác định MCPB cần dùng là version 1.0.8, SHA-256 `413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa`, kích thước lịch sử 97,311 byte.
- Đã tìm trong `dist/`, các artifact MCPB độc lập, các ZIP evidence pack hiện có và các file MCPB trong thư mục home/tmp của workspace; không tìm thấy file MCPB có SHA-256 chính xác đó. File gốc cũng không được Git theo dõi vì `dist/` bị ignore. Các gói Runalith 1.0.9-rc.5 hiện có không phải file thay thế hợp lệ cho artifact freeze.
- Gate scenario cũ vẫn bị khóa; lần ủy quyền one-shot trước đó đã được dùng và không được tái sử dụng. Không chạy scenario khi gate chưa được mở qua quy trình phê duyệt hợp lệ.

## Phân loại bằng chứng và replay

- `VERIFIED`: một kiểm tra cục bộ đã được chạy trực tiếp hoặc verifier độc lập đã tái tính và xác minh các ràng buộc cụ thể. Ghi lệnh và đường dẫn kết quả để có thể lặp lại.
- `INTEGRITY_ONLY`: hash, byte alignment, manifest, raw ledger và provenance tự nhất quán; không đồng nghĩa chữ ký đáng tin, môi trường vận hành hợp lệ hay acceptance.
- `BLOCKED`: một prerequisite bắt buộc đang thiếu, không hợp lệ hoặc mâu thuẫn. Báo blocker cụ thể; không tự sửa bằng cách nới điều kiện.
- `ACCEPTANCE_REQUIRED`: cần quyết định có thẩm quyền cùng bằng chứng operational hiện hành, ràng buộc đúng candidate hash và được xác minh độc lập.

Evidence pack hợp lệ cần có đúng roster command bắt buộc, mã thoát, thời điểm bắt đầu/kết thúc, combined log và raw stdout/stderr sidecar cho từng lệnh. Independent verifier kiểm tra lại checksum inventory, tính nhất quán giữa status và manifest, rồi dựng source snapshot trong clone riêng bằng Git HEAD + tracked patch + untracked-source overlay; sau đó chạy lại source-to-binary verifier trên candidate bytes đã bắt giữ. Các hash/log cục bộ chứng minh tính nhất quán của pack chứ không phải chữ ký xác thực nguồn gốc process log. Không coi cờ `PASS` của producer là bằng chứng duy nhất.

Scorer production hiện bắt buộc receipt tiêu thụ gate một lần được owner ký (`--gate-consumption-receipt`) và ledger durable tại đường dẫn cố định `/var/lib/runalith/agg-phase1-execution-gate-consumptions.jsonl`. Đây là bước xác minh chỉ-đọc: nó ràng buộc receipt với candidate/source/corpus/raw-run hashes, nonce và hash authorization mới, toàn bộ execution IDs cùng một record `CONSUMED_ONCE` duy nhất; không tự cấp, ghi nhận hay mở gate. Ledger phải được host admin provision dưới thư mục root-owned và không cho group/world ghi; caller không được chọn ledger khác. Receipt/ledger hiện chưa được provision và scorer không thể nghiệm thu khi thiếu chúng. Không tạo record giả hoặc thử chạy A/B để tạo dữ liệu này.

Protocol hiện có không định nghĩa signed attestation revocation list. Vì thế không được báo rằng revocation đã được kiểm tra; expiry, ledger ngăn duplicate consumption record và thay trust-root pin không tương đương thu hồi một attestation cụ thể. Nếu revocation được yêu cầu trong acceptance, cần thiết kế và provision registry xác thực theo protocol/version có thẩm quyền trước khi mở gate.

Một lần replay mới phải dùng output directory chưa tồn tại. Nếu packaged inputs thay đổi thực sự, dùng replay mặc định để chạy reproducibility/build/extracted-package E2E. Nếu chỉ thay đổi scorer/tests/docs ngoài archive và candidate lịch sử vẫn alignment với packaged source, dùng chế độ preservation dưới đây để không build lại chỉ nhằm tái xác nhận hash:

```sh
npm run agg:phase1:replay -- --output-dir "$PWD/artifacts/agg-phase1-hardening-NEW" \
  --preserve-existing-candidate \
  "$PWD/artifacts/agg-phase1-hardening-20261023T134921Z-end-to-end/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb"
npm run agg:phase1:verify-evidence -- \
  --evidence-dir "$PWD/artifacts/agg-phase1-hardening-NEW" \
  --source-root "$PWD"
```

Chế độ preservation chỉ chấp nhận đúng candidate lịch sử SHA-256 `7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0` và chỉ khi source-to-binary alignment pass. Nó ghi `package-reproducibility` và extracted-package smoke là `SKIPPED` cùng lý do cụ thể; không được diễn giải chúng thành `PASS`. Nếu packaged inputs không còn alignment, dừng lại và điều tra; không đổi target/proposal/approval để khớp candidate. Pack cuối phải qua independent verifier trên source root hiện tại, với checksum inventory đầy đủ và status `PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE`.

Verifier chỉ được trả `PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE` cho integrity; trạng thái sản phẩm vẫn `PARTIAL_NOT_ACCEPTED` cho đến khi trust roots được provision, corpus 10 scenario được owner ký, authorization mới được cấp và tiêu thụ theo quy trình one-shot, paired operational ledger cùng isolation/adjudication được ràng buộc đúng candidate và được xác minh độc lập.

## Việc cần người dùng/chủ dự án làm trước tiên

**Chỉ một việc ở bước này:** nhờ người quản trị máy, người giữ bản sao lưu hoặc người đã tạo gói gốc tìm lại đúng MCPB có SHA-256 nêu trên. Không tự build lại từ source, không chọn file `1.0.8` chỉ dựa vào tên, và không thay bằng file `1.0.9-rc.5`.

Mẫu tin nhắn có thể sao chép:

> Tôi cần khôi phục đúng MCPB được đóng băng cho benchmark Phase 1, không build lại và không thay phiên bản. SHA-256 bắt buộc: `413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa`; kích thước lịch sử: 97,311 byte. Vui lòng cung cấp bản gốc từ kho lưu trữ/backup và cho biết nguồn của bản sao. Chưa chạy benchmark hoặc thay đổi gate.

Nhờ họ cung cấp file ở vị trí đầu vào riêng, **không ghi đè hoặc thêm vào `dist/`**. Sau khi có file, bước đầu tiên là kiểm SHA-256 và manifest; nếu hash không khớp thì dừng.

## Việc tôi sẽ làm sau khi có artifact đúng

1. Khôi phục và kiểm tra hash/manifest của candidate frozen gốc mà không thay đổi gói gốc.
2. Nếu owner chọn candidate mới, thực hiện re-freeze chính thức để proposal mới ràng buộc chính xác bundle SHA-256 và computed source-snapshot SHA-256; không tái sử dụng owner approval/reviewer signature cho byte cũ.
3. Provision trust roots qua quản trị viên máy theo quy trình ngoài repository; tạo corpus chỉ từ scenario spec đóng băng và để owner tự ký/phê duyệt. Attestations mới phải dùng schema v2/protocolVersion và bind candidate, source snapshot, corpus, plan/freeze hash, scope, freshness và nonce.
4. Kiểm tra scenario gate đã khóa và authorization one-shot qua gate custodian; không dùng lại authorization lịch sử đã tiêu thụ hoặc mở gate từ CLI/environment variable.
5. Chỉ chạy khi môi trường cách ly có attestation độc lập, quyền chạy đúng phạm vi, corpus tin cậy và tất cả trust roots đã được xác minh.
6. Thu raw ledger, lỗi, retry, can thiệp thủ công, artifact hash, chi phí/tài nguyên đo được; ký adjudication độc lập và tạo evidence pack với checksum/provenance có thể xác minh lại.

## Những điều người dùng không cần làm

- Không cần tự viết JSON, script hoặc lệnh shell.
- Không cần tạo hoặc gửi private signing key, mật khẩu hay credential trong chat.
- Không cần tự chấm điểm các scenario.
- Không cần phê duyệt một báo cáo khi bằng chứng còn thiếu.

Nếu không tìm lại được artifact gốc, phải dừng và báo rõ blocker. Chọn một candidate khác sẽ cần quyết định freeze phiên bản bằng quy trình có thẩm quyền trước khi chạy; không được âm thầm thay artifact rồi gọi đó là cùng một phép thử.
