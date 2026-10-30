import QRCode from "qrcode";

export default async function QrPage() {
  const url = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return (
    <main className="grid min-h-dvh place-items-center bg-white p-8">
      <div className="space-y-8 text-center">
        <div
          className="mx-auto aspect-square w-[min(70vh,80vw)] [&>svg]:h-full [&>svg]:w-full"
          role="img"
          aria-label="Código QR de la aplicación"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <p className="text-4xl font-extrabold tracking-tight">{url.replace(/^https?:\/\//, "")}</p>
      </div>
    </main>
  );
}
