# ساخت و آزمون LML VPN ۱.۰.۱

این راهنما برای سورس همین انتشار است. فایل `LML-VPN-1.0.1-source.tar.xz` را از [صفحهٔ انتشار](https://github.com/nukesamp-crypto/LML-VPN/releases/tag/v1.0.1) بگیرید؛ آن علاوه بر پروژهٔ برنامه، سورس‌های بالادستی مشخص‌شده را در `upstream/` و بسته‌های اضافی Cronet/NaïveProxy را در `extra-upstream/` دارد. با `SHA256SUMS.txt` انتشار، دانلود را بررسی کنید. همچنین می‌توان کد برنامه را از خود مخزن گرفت؛ در آن صورت سورس بالادستی لازم را از آرشیو انتشار یا لینک‌های پین‌شده در [اعلان اجزای شخص ثالث](../THIRD-PARTY-NOTICES.md) تأمین کنید.

## پیش‌نیاز

- محیط سازگار x64 برای اجرای برنامه؛ Node.js **۲۲٫۱۲ یا جدیدتر** و npm برای ساخت Electron.
- Go 1.26.10 برای Radiance و Psiphon؛ برای کامپایل Psiphon به هدف x64 یک C compiler سازگار با MinGW-w64 نیز لازم است. Go ممکن است به دانلود وابستگی‌های ماژولیِ ثبت‌شده در `go.mod` و `go.sum` نیاز داشته باشد.
- دسترسی شبکه برای `npm ci` و دریافت باینری‌های رسمی پین‌شده. مجوزها و نشانی‌های دقیق در [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) و `desktop/resources/licenses/` هستند.

## ساخت موتورهای LML از سورس

نمونهٔ زیر یک پوستهٔ Bash روی لینوکس را فرض می‌کند. در سایر محیط‌ها، متغیرها و زنجیرهٔ C را متناسب با محیط خود تنظیم کنید. پس از استخراج آرشیو، از ریشهٔ آن اجرا کنید:

```bash
export LML_DIR="$PWD"
export PSIPHON_SRC="$LML_DIR/upstream/psiphon-tunnel-core-520f37c980df6909830ad541b42c305e648ed60d"
mkdir -p "$LML_DIR/desktop/resources/bin"

# Psiphon با وابستگی‌های vendored در سورس پین‌شده
cd "$PSIPHON_SRC/ConsoleClient"
GOOS=windows GOARCH=amd64 CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc \
  go build -mod=vendor -tags PSIPHON_ENABLE_INPROXY \
  -ldflags='-s -w -checklinkname=0 -X github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon/common/buildinfo.buildRepo=https://github.com/shirokhorshid/psiphon-tunnel-core -X github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon/common/buildinfo.buildRev=520f37c980df6909830ad541b42c305e648ed60d' \
  -o "$LML_DIR/desktop/resources/bin/psiphon-core.exe" .

# Radiance اصلاح‌شده برای سرویس داخلی LML
cd "$LML_DIR/desktop/vendor/radiance"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -tags 'with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api' \
  -ldflags='-s -w -X github.com/getlantern/radiance/common.Version=10.0.5-beta.1' \
  -o "$LML_DIR/desktop/resources/bin/lml-lanternd.exe" ./cmd/lanternd

cd "$LML_DIR/desktop/lantern-helper"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags='-s -w' -o ../resources/bin/lantern-ipc.exe .
```

ساخت مجدد الزاماً بایت‌به‌بایت با باینری تاریخی یکی نیست. آزمون `lantern-reference.test.cjs` عمداً هش daemon و helper **انتشار مرجع** را بررسی می‌کند؛ بنابراین یک ساخت تازه با هش متفاوت ممکن است آن آزمون را ناموفق کند، حتی اگر از همین سورس ساخته شده باشد. از این تفاوت نمی‌توان درستی رفتار ساخت تازه را نتیجه گرفت؛ آن را روی محیط مقصد مستقلاً آزمون کنید.

## دریافت اجزای رسمی و ساخت نصاب

سه اسکریپت زیر فایل‌های رسمی مشخص‌شده را دریافت می‌کنند و پیش از نصب، SHA-256 آن‌ها را با مقادیر پین‌شده در کد تطبیق می‌دهند:

```bash
cd "$LML_DIR/desktop"
node tools/fetch-thefeed.cjs
node tools/fetch-xray.cjs
node tools/fetch-geo.cjs
npm ci
npm test
npm run build:win -- --publish never
```

در لینوکس، برای electron-builder دقیقاً نسخهٔ lockfile و محدودکردن حافظهٔ 7-Zip می‌توان پیش از دستور ساخت `node patch-linux-builder.cjs` را اجرا کرد. این patch فقط ابزار نصب‌شده در `node_modules` را تغییر می‌دهد. خروجی `release-output/LML-VPN-Setup-1.0.1.exe` یک نصاب NSIS برای x64، نصب سراسری و بدون امضای تجاری است. به‌روزرسان خودکار مبتنی بر GitHub در این نسخه حذف شده است؛ دریافت نسخه‌های تازه به‌صورت دستی انجام می‌شود.

`npm test` بخشی از آزمون‌های شبکه‌ای/موتور واقعی را بدون مسیر باینری‌های آزمون، skip می‌کند. موفقیت آزمون‌های محلی یا ساخت نصاب، آزمایش روی محیط مقصد، کنترل سرویس، کارکرد تمام شبکه‌ها یا ورود واقعی به TheFeed را تضمین نمی‌کند.
