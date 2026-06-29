import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Integritetspolicy — Fråga Fiskargubben",
};

export default function PrivacyStatementPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">
        Integritetspolicy
      </h1>
      <p className="mb-10 text-sm text-muted-foreground">
        Senast uppdaterad: 2026-06-29
      </p>

      <div className="flex flex-col gap-6 text-sm leading-7 text-foreground">
        <section>
          <h2 className="mb-2 text-lg font-medium">
            1. Uppgifter vi samlar in
          </h2>
          <p>
            När du skapar ett konto lagrar vi ditt namn och din e-postadress.
            Loggar du in via Google eller Microsoft tar vi emot namn, e-post och
            en kontoidentifierare från den leverantören.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">
            2. Hur uppgifterna används
          </h2>
          <p>
            Uppgifterna används enbart för att tillhandahålla tjänsten:
            autentisering, kontohantering och support. Vi säljer inte dina
            uppgifter.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">3. Lagring</h2>
          <p>
            Uppgifterna lagras så länge ditt konto är aktivt. Du kan begära att
            ditt konto och dina uppgifter raderas.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">4. Tredjepartstjänster</h2>
          <p>
            Vi använder Google och Microsoft för inloggning. Deras hantering av
            uppgifter styrs av deras egna integritetspolicyer.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">5. Dina rättigheter</h2>
          <p>
            Enligt GDPR har du rätt att få tillgång till, rätta eller radera
            dina uppgifter. Kontakta oss för att utöva dessa rättigheter.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">6. Kontakt</h2>
          <p>
            Frågor om personuppgifter skickas till
            integritet@fragafiskargubben.se.
          </p>
        </section>
      </div>
    </main>
  );
}
