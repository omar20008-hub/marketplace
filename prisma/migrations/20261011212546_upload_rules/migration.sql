-- Platform copies of the upload policy: the node whitelist and the credential types.
-- Additive: two new tables, seeded once. Changes to the policy are made here after this.

-- CreateTable
CREATE TABLE "NodeRule" (
    "nodeType" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "NodeRule_pkey" PRIMARY KEY ("nodeType")
);

-- CreateTable
CREATE TABLE "CredentialRule" (
    "credentialType" TEXT NOT NULL,
    "durability" TEXT NOT NULL,
    "appRegistered" BOOLEAN NOT NULL DEFAULT false,
    "authFlow" TEXT,
    "flowReady" BOOLEAN,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CredentialRule_pkey" PRIMARY KEY ("credentialType")
);

-- Seeded from the n8n policy tables as they stood when the platform took over uploads.
INSERT INTO "NodeRule" ("nodeType", "verdict", "note") VALUES
  ('n8n-nodes-base.executeWorkflowTrigger', 'allow', 'المشغّل الإلزامي لكل قالب'),
  ('n8n-nodes-base.httpRequest', 'allow', 'مع حظر النطاقات الداخلية'),
  ('n8n-nodes-base.set', 'allow', ''),
  ('n8n-nodes-base.if', 'allow', ''),
  ('n8n-nodes-base.switch', 'allow', ''),
  ('n8n-nodes-base.merge', 'allow', ''),
  ('n8n-nodes-base.splitInBatches', 'allow', ''),
  ('n8n-nodes-base.splitOut', 'allow', ''),
  ('n8n-nodes-base.aggregate', 'allow', ''),
  ('n8n-nodes-base.filter', 'allow', ''),
  ('n8n-nodes-base.dateTime', 'allow', ''),
  ('n8n-nodes-base.noOp', 'allow', ''),
  ('n8n-nodes-base.stickyNote', 'allow', ''),
  ('n8n-nodes-base.scheduleTrigger', 'allow', ''),
  ('n8n-nodes-base.code', 'review', 'يتطلب مراجعة يدوية للكود'),
  ('n8n-nodes-base.executeCommand', 'deny', 'تنفيذ أوامر على الخادم'),
  ('n8n-nodes-base.ssh', 'deny', 'اتصال بخوادم أخرى بصلاحيات الخادم'),
  ('n8n-nodes-base.ftp', 'review', 'اتصال بخادم خارجي، يُراجَع'),
  ('n8n-nodes-base.executeWorkflow', 'allow', 'محمي بـ callerPolicy على ورك فلوهات المنصة'),
  ('n8n-nodes-base.readWriteFile', 'deny', 'وصول لنظام ملفات الخادم'),
  ('n8n-nodes-base.googleDrive', 'transform', 'يُستبدل آلياً بطبقة التخزين'),
  ('n8n-nodes-base.awsS3', 'transform', 'يُستبدل آلياً بطبقة التخزين'),
  ('n8n-nodes-base.s3', 'transform', 'يُستبدل آلياً بطبقة التخزين'),
  ('n8n-nodes-base.localFileTrigger', 'deny', 'مراقبة نظام ملفات الخادم'),
  ('n8n-nodes-base.n8n', 'deny', 'إدارة خادم n8n نفسه'),
  ('n8n-nodes-base.errorTrigger', 'deny', 'مشغّل أخطاء الخادم');
INSERT INTO "CredentialRule" ("credentialType", "durability", "appRegistered", "authFlow", "flowReady", "note") VALUES
  ('httpHeaderAuth', 'durable', FALSE, NULL, NULL, 'مفتاح ثابت في الترويسة'),
  ('httpBasicAuth', 'durable', FALSE, NULL, NULL, 'اسم مستخدم وكلمة مرور'),
  ('httpQueryAuth', 'durable', FALSE, NULL, NULL, 'مفتاح في رابط الطلب'),
  ('httpCustomAuth', 'durable', FALSE, NULL, NULL, 'مصادقة مخصصة بمفاتيح ثابتة'),
  ('facebookGraphApi', 'durable', FALSE, NULL, NULL, 'توكن وصول طويل الأجل'),
  ('openAiApi', 'durable', FALSE, NULL, NULL, 'مفتاح API'),
  ('anthropicApi', 'durable', FALSE, NULL, NULL, 'مفتاح API'),
  ('googlePalmApi', 'durable', FALSE, NULL, NULL, 'مفتاح API'),
  ('serpApi', 'durable', FALSE, NULL, NULL, 'مفتاح API'),
  ('notionApi', 'durable', FALSE, NULL, NULL, 'توكن داخلي'),
  ('airtableTokenApi', 'durable', FALSE, NULL, NULL, 'توكن شخصي'),
  ('telegramApi', 'durable', FALSE, NULL, NULL, 'توكن بوت'),
  ('postgres', 'durable', FALSE, NULL, NULL, 'بيانات اتصال ثابتة'),
  ('mySql', 'durable', FALSE, NULL, NULL, 'بيانات اتصال ثابتة'),
  ('aws', 'durable', FALSE, NULL, NULL, 'مفاتيح وصول ثابتة'),
  ('gmailOAuth2', 'blocked', FALSE, NULL, NULL, 'يحتاج تسجيل تطبيق المنصة لدى Google'),
  ('googleDriveOAuth2Api', 'blocked', FALSE, NULL, NULL, 'يحتاج تسجيل تطبيق المنصة لدى Google'),
  ('googleSheetsOAuth2Api', 'blocked', FALSE, NULL, NULL, 'يحتاج تسجيل تطبيق المنصة لدى Google'),
  ('slackOAuth2Api', 'blocked', FALSE, NULL, NULL, 'يحتاج تسجيل تطبيق المنصة لدى Slack'),
  ('microsoftOutlookOAuth2Api', 'blocked', FALSE, NULL, NULL, 'يحتاج تسجيل تطبيق المنصة لدى Microsoft');
