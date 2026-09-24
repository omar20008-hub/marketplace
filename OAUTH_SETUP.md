# OAuth Setup Guide

## المنتجات المعلقة (4 منتجات)

حالياً 8 من 12 منتج تعمل بشكل كامل. الـ 4 المتبقية تحتاج OAuth:

1. **Google Sheets** (googleSheetsOAuth2Api)
2. **Google Drive** (googleDriveOAuth2Api)
3. **Microsoft Teams** (microsoftTeamsOAuth2Api)
4. منتج رابع

---

## المشكلة الحالية

```typescript
// src/lib/n8n/mock.ts
flowReady: false  // ← OAuth flows لم تُعيّن بعد
```

عند محاولة الاتصال برصيد OAuth، يظهر:
```
${type} requires signing in through the platform, which is not available yet.
```

---

## خطوات الإعداد (4 مراحل)

### **المرحلة 1: إعداد Google OAuth**

#### 1.1 إنشاء Google Cloud Project

1. اذهب إلى [Google Cloud Console](https://console.cloud.google.com/)
2. أنشئ **New Project** (أو اختر موجود)
3. اسم المشروع: `marketplace-oauth` (أو أي اسم)
4. اضغط **Create**

#### 1.2 تفعيل الـ APIs

1. اذهب إلى **APIs & Services** → **Library**
2. ابحث عن **Google Sheets API** وفعّلها
3. ابحث عن **Google Drive API** وفعّلها

#### 1.3 إنشاء OAuth 2.0 Credentials

1. اذهب إلى **APIs & Services** → **Credentials**
2. اضغط **Create Credentials** → **OAuth client ID**
3. اختر **Web application**
4. في **Authorized redirect URIs** أضف:
   ```
   https://your-n8n-instance.com/rest/oauth2/callback/googleSheetsOAuth2Api
   https://your-n8n-instance.com/rest/oauth2/callback/googleDriveOAuth2Api
   ```
5. انسخ:
   - **Client ID**
   - **Client Secret**

---

### **المرحلة 2: إعداد Microsoft OAuth**

#### 2.1 إنشاء Azure App Registration

1. اذهب إلى [Azure Portal](https://portal.azure.com/)
2. اختر **App registrations** → **New registration**
3. اسم التطبيق: `marketplace-oauth`
4. **Redirect URI:**
   ```
   https://your-n8n-instance.com/rest/oauth2/callback/microsoftTeamsOAuth2Api
   ```
5. اضغط **Register**

#### 2.2 إنشاء Client Secret

1. اذهب إلى **Certificates & secrets**
2. اضغط **New client secret**
3. انسخ:
   - **Client ID**
   - **Client Secret Value**

#### 2.3 تفعيل الـ API Permissions

1. اذهب إلى **API permissions**
2. أضف هذه الأذونات:
   - `Team.ReadBasic.All`
   - `Channel.ReadBasic.All`
   - `Chat.ReadWrite`

---

### **المرحلة 3: إعداد n8n OAuth**

#### 3.1 إضافة Google Credentials إلى n8n

1. في n8n Dashboard: **Credentials** → **New**
2. نوع الـ Credential: **Google Sheets OAuth2 API**
3. ملء البيانات:
   - **Client ID:** من Google Cloud
   - **Client Secret:** من Google Cloud
   - **Redirect URL:** ترك الافتراضي
4. اضغط **Authenticate with Google** (يفتح نافذة تسجيل دخول Google)
5. وافق على الأذونات
6. احفظ الـ Credential

#### 3.2 إضافة Microsoft Teams Credentials إلى n8n

1. في n8n Dashboard: **Credentials** → **New**
2. نوع الـ Credential: **Microsoft Teams OAuth2 API**
3. ملء البيانات:
   - **Client ID:** من Azure
   - **Client Secret:** من Azure
4. اضغط **Authenticate with Microsoft**
5. وافق على الأذونات
6. احفظ الـ Credential

---

### **المرحلة 4: تحديث الكود والمتغيرات**

#### 4.1 تحديث متغيرات Railway

في Railway → Node.js app → **Variables** أضف:

```
N8N_OAUTH_GOOGLE_SHEETS_CLIENT_ID=<من Google Cloud>
N8N_OAUTH_GOOGLE_SHEETS_CLIENT_SECRET=<من Google Cloud>
N8N_OAUTH_GOOGLE_DRIVE_CLIENT_ID=<من Google Cloud>
N8N_OAUTH_GOOGLE_DRIVE_CLIENT_SECRET=<من Google Cloud>
N8N_OAUTH_MICROSOFT_TEAMS_CLIENT_ID=<من Azure>
N8N_OAUTH_MICROSOFT_TEAMS_CLIENT_SECRET=<من Azure>
N8N_OAUTH_REDIRECT_URL=https://marketplace-production-3f79.up.railway.app
```

#### 4.2 تحديث الكود

**في `src/lib/n8n/mock.ts`:**

```typescript
// تغيير flowReady من false إلى true
googleSheetsOAuth2Api: { 
  durability: "durable", 
  authFlow: "oauth", 
  flowReady: true  // ← تغيير من false
},
googleDriveOAuth2Api: { 
  durability: "durable", 
  authFlow: "oauth", 
  flowReady: true  // ← تغيير من false
},
microsoftTeamsOAuth2Api: { 
  durability: "durable", 
  authFlow: "oauth", 
  flowReady: true  // ← تغيير من false
},
```

#### 4.3 Push والتوزيع

```powershell
cd C:\Users\Rouad\Marketplace
git add .
git commit -m "Enable OAuth flows for Google Sheets, Drive, and Teams"
git push origin main
```

Railway ستبدأ بناء جديد تلقائياً.

---

## الاختبار

بعد انتهاء البناء:

1. اذهب إلى التطبيق
2. حاول الاتصال برصيد Google Sheets
3. سيفتح نافذة تسجيل دخول Google
4. وافق على الأذونات
5. يجب أن تنجح عملية الاتصال ✅

---

## ملاحظات مهمة

⚠️ **الأمان:**
- لا تضع Client Secrets في الكود
- استخدم متغيرات البيئة فقط
- في Railway، المتغيرات آمنة ومشفرة

⚠️ **الترخيص:**
- Google و Microsoft قد تحتاجان إلى التحقق من التطبيق
- قد تستغرق المراجعة من ساعات إلى أيام

⚠️ **Redirect URLs:**
- استخدم الرابط الدقيق لـ Railway
- تأكد من مطابقة التطبيق والـ Dashboard

---

## الموارد الإضافية

- [Google OAuth Documentation](https://developers.google.com/identity/protocols/oauth2)
- [Microsoft OAuth Documentation](https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow)
- [n8n Credentials Documentation](https://docs.n8n.io/credentials/)

---

## الحالة الحالية

✅ **تم الإطلاق بنجاح:**
- 8/12 منتج تعمل
- قاعدة البيانات متصلة
- الـ Health check يعمل

⏳ **المعلقة (لاحقاً):**
- Google Sheets OAuth
- Google Drive OAuth
- Microsoft Teams OAuth
- منتج رابع
