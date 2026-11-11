# المرحلة 1، الخطوة 1: صورة المتصفح المعزولة (نتائج الاختبار)

**الحالة:** منفَّذة ومختبرة على الخادم التجريبي. تكمل `docs/browser-service-phase0.md`. لم يُربط شيء بالمساعد بعد.

## ما بُني

صورة Docker باسم `hermes-browser:phase1-145` (حجمها نحو 1.27 جيجابايت):

- أساسها `debian` مثبَّت بـ digest، وليس بوسم متحرك.
- Chrome for Testing 145.0.7632.6 منسوخ من نسخة تم التحقق من تطابقها، ومملوك لـ root وللقراءة فقط (`a+rX,a-w`).
- مستخدم غير مميز `uid 10001`، ونقطة دخول تشغّل `chrome --headless=new` مع `--user-data-dir=/tmp/profile`.

## إعدادات التشغيل المعتمدة

كل مهمة تُشغَّل في حاوية جديدة بهذه الإعدادات، وتُحذف بعد انتهائها:

| الإعداد | الغرض |
|---|---|
| `--network none` في الاختبار (في الإنتاج: شبكة مخصصة بقواعد جدار ناري، الخطوة 2) | لا وصول إلى المضيف ولا الشبكة الداخلية |
| `--read-only` + `--tmpfs /tmp` + `--tmpfs /home/browser` | لا شيء يُكتب خارج الذاكرة، ولا ملف تعريف يبقى |
| `--cap-drop ALL` + `--security-opt no-new-privileges` | لا صلاحيات (`CapEff` كله أصفار) |
| `--pids-limit 256 --memory 700m --cpus 1` | حدود الموارد لكل مهمة |
| `--user 10001` | مستخدم غير مميز |
| `-e HOME=/home/browser -e XDG_CONFIG_HOME=/tmp/xdg-config -e XDG_CACHE_HOME=/tmp/xdg-cache` | بدونها يفشل معالج الأعطال `chrome_crashpad_handler: --database is required` |
| `--security-opt seccomp=<الملف المخصص>` | يسمح لـ Chrome ببناء عزله الداخلي (sandbox) انظر التالي |

## ملف seccomp المخصص

ملف seccomp الافتراضي في Docker يمنع `clone` بعلامات `user namespace` و`unshare` و`chroot` لمن لا يملك `CAP_SYS_ADMIN` و`CAP_SYS_CHROOT`. ونحن نسقط كل الصلاحيات، فيفشل عزل Chrome الداخلي برسالة `No usable sandbox!`.

الحل: الملف الافتراضي الرسمي نفسه مع قاعدة واحدة مضافة تسمح بالاستدعاءات الثلاثة فقط:

```json
{"names": ["clone", "unshare", "chroot"], "action": "SCMP_ACT_ALLOW"}
```

- المصدر: `https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json` (نُقل من `moby/moby`)، جُلب في 2026-11-11، وبصمته `sha256 15434cc9c9037d85b35027a60721bf45f381782b4283b01d94663366e71569f8`.
- الأثر: هذه الاستدعاءات تعمل داخل `namespace` يخص Chrome، ولا تمنح الحاوية صلاحية على المضيف. لكنها تفتح سطح هجوم إضافياً على النواة (ميزات `user namespaces`)، وهو الثمن المقبول مقابل بقاء عزل Chrome الداخلي. **يُدرج في المراجعة الأمنية.**
- **لا يُستعمل `--no-sandbox` ولا `--cap-add`.**
- النواة على الخادم تسمح بـ `user namespaces` لمستخدم عادي (`max_user_namespaces = 14447`).
- الملف المخصص يعيد توليده سكربت من الملف الافتراضي، ولا يُحرَّر يدوياً. عند تحديث Docker يُعاد الجلب ويُقارن.

## نتائج الاختبار

| الاختبار | النتيجة |
|---|---|
| إصدار Chrome | 145.0.7632.6 |
| المستخدم | `uid=10001` |
| `CapEff` | `0000000000000000` |
| الكتابة في `/etc` | مرفوضة (`Read-only file system`)، وفي `/tmp` تنجح |
| ملفات المضيف | لا `/home/hmt-001` ولا `/srv` داخل الحاوية |
| مكتبات ناقصة | لا شيء |
| الـsandbox مع الملف المخصص | يعمل، بلا `No usable sandbox` |
| CDP على `127.0.0.1:9222` داخل الحاوية | يستجيب (`Protocol-Version 1.3`) وفيه صفحة `about:blank` |
| `docker diff` بعد التشغيل | فارغ |

## أخطاء واجهناها وحلولها (للرجوع)

1. `Invalid file descriptor to ICU data received`: ملفات Chrome كانت `0400` لـ root. أُصلحت بـ `chmod -R a+rX,a-w`.
2. `chrome_crashpad_handler: --database is required`: أُصلحت بمتغيرات `XDG_*` و`HOME` أعلاه. الأعلام `--disable-breakpad` و`--crash-dumps-dir` لم تنفع.
3. `No usable sandbox!`: ملف seccomp المخصص أعلاه. ثم `sys_chroot` فأضيف `chroot`.
4. `--dump-dom about:blank` لا ينتهي في وضع headless الجديد داخل هذه البيئة، سواء مع seccomp المخصص أو بدونه، فلا علاقة له بالعزل. **لا يُعتمد عليه اختباراً.** الاختبار المعتمد هو CDP.
5. خادم CDP يرفض طلبات `HTTP/1.0`، ويُبقي الاتصال مفتوحاً مع `Connection: close`. اختبارات `curl`/`bash` تحتاج `HTTP/1.1` ومهلة.

## الخطوات التالية في المرحلة 1

2. شبكة Docker مخصصة وقواعد جدار ناري تمنع الحاويات من الوصول إلى المضيف والنطاقات الخاصة، مع إبقاء الإنترنت العام (يحتاج موافقة قبل التنفيذ لأنه يمس جدار الخادم).
3. وسيط (broker) يعمل خدمة بصلاحيات root: يُنشئ الحاوية، ويربط واجهة CDP بمقبس unix، ويفرض المهل والحصص.
4. اختبار رفع ملف على `https://the-internet.herokuapp.com/upload` مع رفض أي مسار خارج مجلد المستخدم.
5. الربط مع Hermes (أداة `browser_upload`).
