import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "سياسة الخصوصية | Builder",
  description: "كيف يجمع Builder بياناتك ويستخدمها ويحميها.",
};

const CONTACT_EMAIL = "support@example.com";
const UPDATED = "15 أكتوبر 2026";

export default function PrivacyPage() {
  return (
    <main dir="rtl" className="mx-auto max-w-3xl px-6 py-12 leading-8 text-zinc-800">
      <h1 className="mb-2 text-3xl font-bold">سياسة الخصوصية</h1>
      <p className="mb-10 text-sm text-zinc-500">آخر تحديث: {UPDATED}</p>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">1. من نحن</h2>
        <p>
          Builder منصة سوق للوكلاء وسير العمل المبنية على n8n. هذه الصفحة تشرح البيانات
          التي نجمعها عند استخدامك للمنصة، ولماذا، وكيف تتحكم فيها.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">2. البيانات التي نجمعها</h2>
        <ul className="list-disc space-y-2 pr-6">
          <li>
            <strong>بيانات الحساب:</strong> الاسم والبريد الإلكتروني عند تسجيل الدخول بحساب
            Google.
          </li>
          <li>
            <strong>المحادثات:</strong> الرسائل التي ترسلها إلى المساعد وردوده، لتعرض لك سجل
            المحادثة.
          </li>
          <li>
            <strong>قنوات المراسلة:</strong> عند ربط حسابك بتيليجرام أو واتساب، نحفظ معرّف
            المحادثة الخاص بك في هذه القناة لربطها بحسابك في المنصة.
          </li>
          <li>
            <strong>الملفات والوسائط:</strong> الصور والفيديوهات التي يُنشئها المساعد لك، أو
            التي ترفعها، وتُحفظ لمدة 90 يوماً ثم تُحذف تلقائياً.
          </li>
          <li>
            <strong>ملفات Google Drive:</strong> إذا ربطت حساب Google Drive واخترت مجلداً،
            تُقرأ الملفات في ذلك المجلد لتكون مصدراً للإجابات، ويمكنك إلغاء الربط في أي وقت.
          </li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">3. كيف نستخدم البيانات</h2>
        <ul className="list-disc space-y-2 pr-6">
          <li>تشغيل المساعد والأدوات التي تفعّلها وعرض نتائجها لك.</li>
          <li>ربط حسابك عبر القنوات المختلفة والرد على رسائلك فيها.</li>
          <li>تحسين الأمان ومنع إساءة الاستخدام.</li>
        </ul>
        <p className="mt-3">
          لا نبيع بياناتك ولا نستخدمها للإعلانات.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">4. معالجة الذكاء الاصطناعي</h2>
        <p>
          تُرسل رسائلك والمحتوى الذي تختار مشاركته إلى نماذج الذكاء الاصطناعي لمعالجتها
          وتوليد الرد. تُدار هذه المعالجة عبر مزودي الخدمة التاليين فقط، وفق شروطهم:
          Google (Gemini) وخدمة n8n التي تشغّل سير العمل.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">5. مشاركة البيانات</h2>
        <p>
          لا نشارك بياناتك مع أطراف أخرى إلا مزودي الخدمة الضروريين لتشغيل المنصة المذكورين
          أعلاه، أو عند طلب قانوني ملزم.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">6. حفظ البيانات وحذفها</h2>
        <p>
          نحتفظ بالبيانات طالما حسابك نشط. عند إلغاء تفعيل أداة تُحذف نسختك منها وحساباتها
          المرتبطة، ويمكنك طلب حذف حسابك وبياناته بالتواصل معنا. تبقى الملفات المخزّنة عند
          إلغاء تفعيل الأداة حتى تطلب حذفها بنفسك.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">7. أمان البيانات</h2>
        <p>
          تُخزَّن بيانات الاعتماد الخاصة بالحسابات المرتبطة مشفّرة، ولا تُعرض مرة أخرى في
          الصفحات. نستخدم اتصالاً مشفّراً (HTTPS) لكل الخدمات.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">8. حقوقك</h2>
        <p>
          يحق لك الاطلاع على بياناتك وتصحيحها وطلب حذفها وسحب موافقتك في أي وقت، عبر
          التواصل معنا على البريد أدناه.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">9. التواصل</h2>
        <p>
          للاستفسار أو طلب حذف البيانات:{" "}
          <a className="text-blue-700 underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </p>
      </section>
    </main>
  );
}
