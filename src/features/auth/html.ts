// Templat HTML - disalin dari marc_go handlers/auth.go (jenama #2F6B4F).
// Gaya inline sengaja: Gmail/Outlook membuang blok <style>.
import { escapeHtml } from '../../shared/email'

export function verificationEmailHtml(address: string, link: string): string {
  const a = escapeHtml(address)
  const l = escapeHtml(link)
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background-color:#FAF9F6;font-family:Helvetica,Arial,sans-serif;color:#1C1B19;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF9F6;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background-color:#FFFFFF;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#2F6B4F;padding:24px 32px;">
          <span style="font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:0.5px;">MARC</span>
          <div style="margin-top:4px;font-size:12px;color:#D7E5DC;">Kelab Sukan dan Rekreasi MAIWP</div>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 8px;font-size:12px;color:#6B6B6B;text-transform:uppercase;letter-spacing:0.5px;">Pengesahan akaun</p>
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;line-height:1.3;color:#1C1B19;">Sahkan emel anda</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">
            Permintaan diterima untuk mengesahkan <strong>${a}</strong> sebagai
            alamat emel akaun MARC anda.
          </p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.55;">
            Pautan ini luput dalam <strong>1 jam</strong>. Selepas disahkan,
            kembali ke aplikasi untuk teruskan.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td style="background-color:#2F6B4F;border-radius:8px;">
              <a href="${l}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;">Sahkan emel</a>
            </td></tr>
          </table>
          <p style="margin:0 0 6px;font-size:12px;color:#6B6B6B;">Atau salin pautan ini ke pelayar:</p>
          <p style="margin:0;font-size:12px;line-height:1.5;word-break:break-all;color:#2F6B4F;">${l}</p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #E4E1DA;">
          <p style="margin:0;font-size:12px;color:#6B6B6B;line-height:1.5;">
            Jika anda tidak meminta pengesahan ini, abaikan emel ini.
            Jangan kongsi pautan dengan sesiapa.<br>
            Emel automatik daripada sistem MARC.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export const verificationPage = (message: string): string => `<!doctype html>
<html lang="ms"><head><meta charset="utf-8"><title>Pengesahan Email MARC</title></head>
<body style="font-family: sans-serif; padding: 40px; text-align: center;">
<h2>MARC</h2>
<p>${message}</p>
</body></html>`

export const passwordResetEmailHtml = (link: string): string =>
  `<p>Kami terima permintaan untuk reset kata laluan akaun MARC anda. ` +
  `Klik pautan di bawah untuk tetapkan kata laluan baharu (luput dalam 1 jam):</p>` +
  `<p><a href="${link}">${link}</a></p>` +
  `<p>Kalau bukan anda yang minta, abaikan emel ni - kata laluan anda tak berubah.</p>`
