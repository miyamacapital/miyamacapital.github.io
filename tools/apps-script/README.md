# 研究訂閱系統（Google Sheets + Gmail）

網站表單 → Google Apps Script → 名單存在你自己的 Google Sheet；確認信、PDF 報告都從你的 Google Workspace 信箱寄出。不需要額外帳號，也不用改 DNS。

```
www.miyamacap.com/#subscribe ──POST──▶ Apps Script (doPost)
                                          │ 寫入 Subscribers（status = pending）
                                          │ 寄確認信（連結 7 天內有效）
訂閱者點確認連結 ──GET──▶ Apps Script (doGet) → status = confirmed → 導回 /zh/subscribed.html?s=confirmed
你在 Sheet 選單按「寄出」 ──▶ 逐封寄 PDF 給 confirmed 的人（每封有個人退訂連結；退訂要再按一次確認鈕）
```

網站端需要的頁面都已在 repo 裡：`zh/`、`en/`、`jp/` 各自的 `privacy.html`（隱私權政策，信尾會連過去）和 `subscribed.html`（確認／退訂後導回的頁面）。

## 一、第一次設定（約 20 分鐘）

1. **建立 Google Sheet**。用 `connect@miyamacap.com` 所屬的 Google 帳號登入，建立一個新的試算表，命名例如 `Miyama 研究訂閱`。不要用「知道連結的人」分享這份試算表。
2. **貼上程式**。在試算表裡選 `擴充功能 → Apps Script`，把 `Code.gs` 的內容全部貼進去（取代預設的 `myFunction`），按儲存。
3. **設定 Script properties**。左側齒輪 `專案設定` → 捲到最下面 `指令碼屬性` → `新增指令碼屬性`，填完要按 `儲存指令碼屬性`：

   | 屬性 | 必填 | 值 |
   |---|---|---|
   | `SPREADSHEET_ID` | 自動 | 第 4 步 `setup` 會從綁定的試算表儲存，不需手動填。Web App 無法使用「目前開啟的試算表」，會用這個 ID 開啟名單資料庫 |
   | `POSTAL_ADDRESS` | 是 | 公司的實體郵寄地址（美國 CAN-SPAM 規定每封信都要印出來）|
   | `WEB_APP_URL` | 是（第 5 步之後填）| 部署後以 `/exec` 結尾的網頁應用程式網址。信裡的確認／退訂連結都靠它產生 |
   | `REPORTS_FOLDER_ID` | 寄報告時必填 | 放 PDF 的 Google Drive 資料夾 ID（開啟資料夾，網址 `folders/` 後面那串）。資料夾要在同一個 Google 帳號的雲端硬碟，或已分享給它 |
   | `SENDER` | 否 | 要用來寄信的別名，例如 `connect@miyamacap.com`。這個別名必須先在 Gmail 設定 → 帳戶 → 「以這個地址寄送郵件」加好並驗證；沒加的話留空，會用登入帳號本身寄 |
   | `FROM_NAME` | 否 | 預設 `Miyama Capital` |
   | `REPLY_TO` | 否 | 預設 `connect@miyamacap.com` |
   | `SITE_ORIGIN` | 否 | 預設 `https://www.miyamacap.com` |
   | `ALERT_EMAIL` | 否 | 後端錯誤通知要寄到的信箱。留空就寄給部署程式的帳號本身（詳見第四節）|

4. **建立工作表並授權**。回到編輯器，上方函式選單選 `setup`，按 `執行`。第一次會跳出授權：按 `審查權限` → 選帳號 → 會出現「Google 尚未驗證這個應用程式」的紅字畫面，這是正常的（程式是你自己的）：按左下 `進階` → `前往 ○○（不安全）` → 勾選全部 → `允許`。會要求的權限：所有 Google 試算表、所有 Gmail（含寄信）、所有雲端硬碟檔案、你的電子郵件地址、在試算表顯示選單。權限只授予你自己的帳號，網站訪客不會看到任何授權畫面。

   執行完會儲存這份試算表的 `SPREADSHEET_ID`，自動建立 `Subscribers`、`Campaigns`、`Log` 三個工作表，並列出還沒設定的屬性。請從綁定的試算表開啟編輯器執行這一步；未執行時，Web App 會回覆尚未設定，不會新增訂閱者或寄信。之後重新整理試算表分頁，工具列會多一個 `Miyama 訂閱` 選單。
5. **部署成 Web App**。右上 `部署 → 新增部署作業` → 左上齒輪選 `網頁應用程式`：
   - 執行身分：**我**
   - 誰可以存取：**所有人**（表單是匿名送出的，一定要選這個；選「所有擁有 Google 帳戶的使用者」網站上會送不出去）

   部署後複製 `網頁應用程式網址`（以 `/exec` 結尾：`https://script.google.com/macros/s/…/exec`，Workspace 帳號有時會顯示成 `https://script.google.com/a/macros/miyamacap.com/s/…/exec`，兩種都可以；不是 `/dev`，也不是部署作業 ID），回到第 3 步填入 `WEB_APP_URL`，再執行一次 `setup` 確認「設定已齊全」。

   缺少公司郵寄地址、缺少有效的 `/exec` 網址時，訂閱申請會回覆尚未設定，不會建立待確認名單或寄出壞連結。已存在的退訂操作不會因寄信設定缺少而被擋住。
6. **把網址填進網站**。在 `zh/index.html`、`en/index.html`、`jp/index.html` 三個檔案裡，把表單的 `action="__SUBSCRIBE_ENDPOINT__"` 換成同一個 `/exec` 網址，commit 並推上去。
7. **測試**。在網站上用自己的信箱訂閱一次，走完整個流程：
   - 應該收到確認信 → 點連結 → 瀏覽器網址列應該變成 `www.miyamacap.com/zh/subscribed.html?s=confirmed`（不是停在 script.google.com）→ 再收到一封「訂閱完成」信。
   - Sheet 的 `Subscribers` 多一列，`status` 從 `pending` 變成 `confirmed`。
   - 點信尾的「取消訂閱」→ 出現確認頁 → 按「確認取消訂閱」→ 導回 `subscribed.html?s=unsubscribed`，`status` 變成 `unsubscribed`。
   - 三種語言各測一次（en、jp 會收到英文／日文信）。
   - 用未登入 Google 的無痕視窗再試一次，確定訪客不需要 Google 帳號。

   設定好之後，程式遇到錯誤會寄通知信給你（預設寄到部署帳號，可用 `ALERT_EMAIL` 改收件人，每小時最多一封，詳見第四節）。

   **沒收到確認信？** (1) 同一個信箱一小時內重送不會再寄（已退訂的信箱是 24 小時）；(2) 表單在 2 秒內送出會被當成機器人，不寄信；(2b) 全站每 10 分鐘 30 封／每天 300 封的上限或 Gmail 每日額度用完時也會不寄，但網站仍顯示「請到信箱確認」，`Log` 會記 `dropped`；(3) 看 Apps Script 左側 `執行作業` 有沒有紅色錯誤、Sheet 的 `Log` 有沒有 `error` 列；(4) 檢查垃圾郵件匣。測試時要重寄，可以把該列的 `last_sent_at` 清空。

> 之後若修改 `Code.gs`，要 `部署 → 管理部署作業 → 編輯（鉛筆）→ 版本：新版本 → 部署`，網址不會變。只按儲存不會更新線上版本。

## 二、寄一份 PDF 報告

1. 把 PDF 上傳到 `REPORTS_FOLDER_ID` 那個資料夾（檔名不要重複）。
2. 在 `Campaigns` 工作表新增一列：

   | 欄位 | 說明 |
   |---|---|
   | `id` | 任意唯一代號，例如 `2026-10-monthly`。同一個 id 重跑不會重複寄 |
   | `subject` | 信件主旨 |
   | `body` | 純文字導言，可用 `{{name}}` 帶入訂閱者姓名 |
   | `pdf_name` | 資料夾裡的檔名，例如 `Miyama-2026-10.pdf` |
   | `lang` | `all`、`zh`、`en` 或 `ja`：只寄給該語言的訂閱者 |
   | `status` / `sent_at` / `sent_count` | 程式自動填 |

3. 停留在 `Campaigns` 工作表，點那一列的任一格，選單 `Miyama 訂閱 → 寄測試信給自己（選取的 Campaign 列）`，確認版面、附件和信尾的退訂連結（應以 `/exec?action=unsubscribe` 開頭）。
4. 選單 `Miyama 訂閱 → 寄出給訂閱者（選取的 Campaign 列）`。每封信都獨立寄出（不是 BCC），信尾自動附上該訂閱者的退訂連結、隱私權政策和公司地址。寄送途中退訂的人會被跳過。

**額度**：付費 Google Workspace 帳號每天 1,500 位收件人（一般 @gmail.com 帳號只有 100；Workspace 試用期間額度更低，付費滿 60 天後才升到 1,500）。確認信、歡迎信也算在同一額度內，程式會在剩 20 封時自動停下。名單超過時，隔天回到 `Campaigns` 選取同一列（`status` 會是 `sending`）再按一次「寄出給訂閱者」，會從上次沒寄到的人接續。單次執行最多 4 分鐘，超過也會停下，同樣再按一次即可。

某位收件人寄送失敗時，該份報告也會維持 `sending`，重新執行時只重試未成功的收件人。若某個信箱每次都失敗（例如地址已不存在），把該訂閱者的 `status` 改成 `unsubscribed`，報告就會變成 `sent`。相同 campaign ID 同時只能有一個寄送執行；重複點選會提示正在寄送，避免重複發信。系統只在取得／釋放短期執行權時加鎖，寄信期間仍可確認訂閱、退訂。若執行被強制中止，最長等 10 分鐘後即可重試。

**附件大小**：上限 25 MB，但實務上建議 PDF 控制在 10 MB 以內（收件方信箱常有更低的限制）；更大的檔案改在 `body` 裡放 Drive「知道連結的人可檢視」的連結。

## 三、名單管理

- `Subscribers` 的 `status`：`pending`（還沒點確認）、`confirmed`（會收到報告）、`unsubscribed`。
- 要匯出名單：篩選 `status = confirmed`，`檔案 → 下載 → CSV`。
- 要手動移除某人：把 `status` 改成 `unsubscribed`，並清空 `name`、`org`、`source`（訂閱者自己退訂時程式會這樣做，隱私權政策也是這樣承諾的）。不要直接刪列，保留退訂紀錄比較好交代。
- `Log` 記錄每一封寄出的報告、錯誤，以及被擋下的機器人申請。**它是防止重複寄送的依據，不要清空。**
- 選單 `清理逾期未確認的申請（30 天）` 會刪掉確認連結過期超過 30 天、始終沒點確認的列。

## 四、安全與合規提醒

- 表單有蜜罐欄位、送出時間檢查、同一信箱一小時只寄一封、全站每 10 分鐘 30 封／每天 300 封的上限，加上雙重確認；機器人填的信箱不會進到 `confirmed`，也不能拿這個端點大量寄信。
- 確認信與歡迎信都計入上面的全站上限。已完成確認後若歡迎信遇到限流或每日額度預留，會略過歡迎信並記錄到 `Log`，訂閱確認狀態仍然成功。
- 退訂是兩步驟（點連結 → 按確認鈕），避免企業信箱的連結掃描器替人退訂。確認訂閱則是一步，掃描器有可能替人確認；目前接受這個風險。
- 每封信都有退訂連結和公司地址（CAN-SPAM）；網站有隱私權政策頁（台灣個資法第 8 條告知義務）。這些文字請法律顧問看過。
- **錯誤通知**：`Log` 只有你打開 Sheet 才看得到，所以每當程式記錄一筆 `error`（表單送出時的例外、確認／退訂連結處理失敗、歡迎信寄不出去）或報告寄送 `failed`，就會另外寄一封「[Miyama 訂閱] 後端錯誤」到 `ALERT_EMAIL`；沒設定就寄給部署程式的 Google 帳號（`setup` 的訊息會顯示實際收件人）。信裡有錯誤內容、受影響的信箱、`Log` 工作表和 Apps Script 執行紀錄的連結。**每小時最多寄一封**（以指令碼屬性 `ALERT_LAST_SENT_AT` 計時，寄失敗會把這一小時的名額還回去），其餘錯誤只寫入 `Log`；通知信也計入 Gmail 每日額度，一天最多 24 封。通知寄不出去不會影響訪客的訂閱請求。收到通知後請到 `Log` 和 Apps Script 左側 `執行作業` 查看完整紀錄。沒有每日摘要信；要看訂閱量請用 GA4 的 `subscribe_*` 事件（網站端 `assets/subscribe.js`）或直接看 `Subscribers`。
- 寄件網域已有 SPF 和 Google 的 DKIM，只缺 DMARC。到管理 `miyamacap.com` DNS 的地方（放現有 `v=spf1 include:_spf.google.com` 那筆 TXT 的服務商）新增 TXT：主機名 `_dmarc`，值 `v=DMARC1; p=none; rua=mailto:connect@miyamacap.com`。`p=none` 只監看不攔截，connect@ 會每天收到各家信箱的 XML 彙整報告；運作幾週沒問題後可改成 `p=quarantine`。

## 五、本機測試

```bash
node tools/apps-script/test.js
```

用記憶體模擬的 Sheet／Gmail 跑一遍訂閱、確認、退訂、限流、寄報告和錯誤通知（一小時一封、通知失敗不影響請求）的流程。

測試也涵蓋 Web App 沒有 active spreadsheet、缺少必要設定時不寫名單／不寄信、歡迎信額度限制、相同 campaign 併發、部分寄送失敗後續寄。這些是本機模擬；匿名存取、實際試算表寫入、寄信別名與授權、信件投遞，以及信中連結跳轉仍須依第 7 步在部署後驗證。
