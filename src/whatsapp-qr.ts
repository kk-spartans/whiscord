import QRCode from "qrcode";

export async function renderWhatsAppQr(qr: string): Promise<string> {
  const rendered = await QRCode.toString(qr, {
    type: "utf8",
  });

  return rendered.replace(/\s+$/, "");
}
