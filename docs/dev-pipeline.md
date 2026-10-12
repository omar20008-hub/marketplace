# خط التطوير الآلي: Trello ← Claude Code ← Pull Request

تنقل بطاقة في Trello إلى قائمة **Ready for Claude**. يلتقطها الـ dispatcher في n8n ويرسلها إلى GitHub.
هناك يعمل Claude Code بوضع headless على اشتراكك (بدون Anthropic API)، فيكتب المواصفات وينفذ ويختبر
ويراجع عبر أربعة subagents، ثم يُفتح Pull Request، ويعود الملخص ورابط الـ PR تعليقًا على البطاقة نفسها.

## المعمارية

```
Trello (قائمة Ready for Claude)
   │  كل 15 دقيقة
   ▼
n8n ① Dispatcher ──repository_dispatch(task-ready)──► GitHub Actions
   │ ينقل البطاقة إلى In Progress                        │
   │                                                     ▼
   │                          Claude Code (headless، OAuth token)
   │                          ├─ spec-writer   → spec.md
   │                          ├─ implementer   → الكود
   │                          ├─ test-runner   → test-report.md   (حتى 3 جولات)
   │                          └─ reviewer      → review            (قراءة فقط، حتى جولتين)
   │                                                     │
   │                          بوابة اختبار مستقلة + فحص المسارات المحمية
   │                                                     │
   │                          commit + push + PR  (خطوات CI حتمية، لا Claude)
   ▼                                                     ▼
n8n ② Result Handler ◄──────────── callback webhook
   ├─ success → قائمة Review + تعليق برابط الـ PR
   └─ failed / blocked → قائمة Needs Attention + السبب أو الأسئلة
```

## الفصل بين المتتبّع والتطوير

العقد بين الأجزاء شكل واحد محايد لا يعرف اسم المتتبّع:

| الحقل | المعنى |
|---|---|
| `tracker` | اسم المتتبّع، وهنا `trello`. الـ Result Handler يرفض أي قيمة أخرى |
| `task_id` | معرّف البطاقة في Trello |
| `task_title` / `task_description` | اسم البطاقة ونص وصفها |
| `task_url` | رابط البطاقة للتعليق والـ PR |

الذي يعرف Trello هو عقد n8n فقط، وهي معزولة داخل كل workflow:

**`n8n/1-task-dispatcher.json`**
- `Tracker: list ready cards`: جلب البطاقات من قائمة Ready for Claude.
- `Normalize Task`: تحويل البطاقة إلى الشكل المحايد.
- `Tracker: move to in progress` و`Tracker: comment started`: نقل البطاقة وتعليق البداية.

**`n8n/2-result-handler.json`**
- `Build Update`: يحدد القائمة الهدف ونص التعليق (محايد).
- `Tracker: move card` و`Tracker: comment result`: نقل البطاقة وتعليق النتيجة.

**عند استبدال المتتبّع مرة أخرى:** استبدل العقد `Tracker:` و`Normalize Task` فقط. الـ GitHub workflow
والـ pipeline وملفات `.claude/` لا تتغير.

| مفهوم Trello | Asana | Notion |
|---|---|---|
| List | Section | قيمة في خاصية Status |
| Card | Task | Page في قاعدة بيانات |
| Comment على البطاقة | Story | Comment على الـ Page |

## محتويات الحزمة

| الملف | الغرض |
|---|---|
| `.github/workflows/claude-dev-agent.yml` | الـ Action الكامل (محايد للمتتبّع) |
| `.claude/pipeline.md` | تعليمات المنسّق (الجلسة الرئيسية) |
| `.claude/pipeline-rules.md` | قواعد المشروع للوكلاء (أوامر، بنية، ممنوعات) |
| `.claude/agents/*.md` | الـ subagents الأربعة |
| `.claude/pipeline-settings.json` | صلاحيات الـ CI (تُمرَّر بـ `--settings`) |
| `n8n/1-task-dispatcher.json` | workflow الالتقاط والإرسال (محول Trello) |
| `n8n/2-result-handler.json` | workflow استقبال النتيجة (محول Trello) |

**لماذا `pipeline-rules.md` وليس `CLAUDE.md`؟** ملف `CLAUDE.md` في الجذر دليل المشروع للتطوير التفاعلي،
وفيه شرط gstack الذي يوقف العمل إذا لم يكن مثبتًا. gstack غير مثبت في CI، لذلك وضعت القواعد الخاصة
بالـ pipeline في ملف منفصل.

## خطوات الإعداد

### 1. Trello
1. أنشئ لوحًا فيه 4 قوائم: `Ready for Claude`، `Claude In Progress`، `Review`، `Needs Attention`.
2. احصل على معرّف كل قائمة (List ID): افتح `https://api.trello.com/1/boards/<BOARD_ID>/lists?key=<KEY>&token=<TOKEN>`
   وانسخ `id` للقائمة المطلوبة. (معرّف اللوح يظهر في رابطه.)
3. أنشئ API key وToken من `https://trello.com/power-ups/admin` (أو صفحة المطورين). الـ Token يعطي
   صلاحية على حسابك، لذلك اجعله مقتصرًا على اللوح المخصص إن أمكن.

> Trello يسمح بوصف حتى 16384 حرفًا. الـ Dispatcher يقص الوصف عند 16000.

### 2. المستودع
1. عدّل `pipeline-rules.md` إذا تغيّرت أوامر المشروع.
2. قائمة `allow` في `.claude/settings.json` تخص التطوير التفاعلي. صلاحيات الـ CI في `pipeline-settings.json`.

### 3. توكن الاشتراك
على جهازك:
```bash
claude setup-token
```
احفظ التوكن (يبدأ بـ `sk-ant-oat01-`)، صالح لسنة، ويُعرض مرة واحدة.

### 4. GitHub Secrets و Variables
**Settings → Secrets and variables → Actions**

Secrets:
- `CLAUDE_CODE_OAUTH_TOKEN`: التوكن من الخطوة 3
- `N8N_CALLBACK_URL`: رابط الـ production لـ webhook الـ Result Handler
- `N8N_CALLBACK_TOKEN`: كلمة سر عشوائية طويلة (نفسها في n8n)

Variables (اختيارية):
- `TEST_COMMAND`: الافتراضي `npm run typecheck && npm run lint && npm test`

> لا تضف `ANTHROPIC_API_KEY` إلى المستودع، حتى لا يُحتسب الاستخدام على الحساب الخطأ.

### 5. n8n
1. استورد الملفين من مجلد `n8n/`.
2. أنشئ Credentials:
   - **Trello API**: الـ API key والـ Token من الخطوة 1
   - **GitHub API**: Fine-grained token على هذا المستودع فقط بصلاحية `Contents: Read and write`
   - **Header Auth**: الاسم `X-Callback-Token` والقيمة = `N8N_CALLBACK_TOKEN`
3. اربط كل HTTP node بالـ credential المناسب، والـ Webhook بالـ Header Auth.
4. في الـ Dispatcher عبّئ عقدة **Config** بمعرّفي `ready_list_id` و`in_progress_list_id`.
   وفي الـ Result Handler عبّئ `review_list_id` و`needs_attention_list_id`.
5. فعّل الـ Result Handler أولًا، ثم انسخ رابط الـ Production URL إلى `N8N_CALLBACK_URL`، ثم فعّل الـ Dispatcher.

### 6. اختبار تجريبي
1. من GitHub: **Actions → Claude Dev Agent → Run workflow** بمهمة بسيطة جدًا (مثل إضافة دالة مع اختبارها)،
   وأدخل معرّف بطاقة حقيقي `task_id` (يمكن أخذه من `https://api.trello.com/1/cards/<short-id>?fields=id&key=...&token=...`).
2. تأكد من: فتح الـ PR، وصول التعليق على البطاقة، انتقال البطاقة إلى Review.
3. بعدها جرّب المسار الكامل بنقل بطاقة إلى `Ready for Claude`.

## كيف تكتب مهمة ينجزها Claude جيدًا
```
العنوان: إضافة فلتر الحالة في صفحة الطلبات

الوصف:
المستخدم يحتاج تصفية الطلبات حسب الحالة.

معايير القبول:
1. قائمة منسدلة بالحالات: جديد، قيد التنفيذ، مكتمل.
2. الفلتر يُطبَّق على الـ API عبر الباراميتر status.
3. عند عدم الاختيار تظهر كل الطلبات.

خارج النطاق: تعديل تصميم الصفحة.
```
القاعدة: مهمة واحدة = PR واحد قابل للمراجعة في 15 دقيقة. المهام الضخمة قسّمها.

## الأمان
- **نص البطاقة مدخل غير موثوق:** أي شخص يستطيع تعديل البطاقات يستطيع توجيه الوكيل. اجعل اللوح مقتصرًا عليك أو على فريق موثوق.
- الصلاحيات في `pipeline-settings.json` تمنع: `git commit` و`git push` و`git checkout` و`gh` و`curl` و`docker` و`prisma migrate` و`npm run migrate` و`WebFetch` وقراءة `.env` وتعديل `.github/` و`.claude/` و`CLAUDE.md`.
- حتى لو تجاوز Claude هذه القيود، بوابة الـ workflow ترفض أي تغيير على المسارات المحمية (`.github/`، `.claude/`، `CLAUDE.md`، `.env*`، `Dockerfile`، `docker-compose.yml`).
- الدمج إلى الفرع الرئيسي دائمًا قرارك أنت. فعّل Branch protection على الفرع الرئيسي.
- الـ PR المفتوح بـ `GITHUB_TOKEN` لا يشغّل workflows أخرى تلقائيًا، فلا يعمل `ci.yml` عليه. لو تريد CI على هذه الـ PRs، استخدم PAT في خطوة الـ PR.

## استكشاف الأخطاء
| العرض | السبب المحتمل |
|---|---|
| لا يحدث شيء بعد نقل البطاقة | الـ Dispatcher غير مفعّل، أو معرّف القائمة خاطئ |
| 401 من Trello | الـ API key أو الـ Token غير صحيح، أو لا يملك صلاحية اللوح |
| 404 من GitHub dispatch | التوكن لا يملك `Contents: Read and write` على المستودع |
| `result.json` غير موجود | وصل لحد `--max-turns`. قسّم المهمة أو ارفع الحد |
| أوامر مرفوضة في السجل | أضف الأمر المطلوب إلى `allow` في `pipeline-settings.json` (ولا تضف أوامر المسارات المحمية) |
| "Changed protected paths" | الوكيل عدّل ملفًا محميًا. راجع المهمة وأعد صياغتها |
| فشل callback بـ 403 | قيمة `X-Callback-Token` لا تطابق |
| الاستخدام يُحتسب على API | وجود `ANTHROPIC_API_KEY` في البيئة |

ملفات `spec.md` و`test-report.md` و`review.md` وسجل Claude محفوظة كـ artifact في كل تشغيل للتتبع.

## خارطة التطوير لاحقًا
1. **المرحلة 1 (الآن):** بطاقة واحدة، مراجعة يدوية لكل PR.
2. **المرحلة 2:** قياس نسبة الـ PRs المقبولة بدون تعديل، وتحسين `pipeline-rules.md` والـ subagents بناءً على أسباب الرفض.
3. **المرحلة 3:** رفع `max_tasks_per_run` أو التشغيل الليلي بعد استقرار الجودة.
4. **عند تغيير المتتبّع مرة أخرى:** استبدل عقد `Tracker:` فقط، حسب الجدول في هذا الملف.
