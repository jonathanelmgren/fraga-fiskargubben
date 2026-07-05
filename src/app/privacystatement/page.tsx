import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Integritetspolicy · Fråga Fiskargubben",
};

export default function PrivacyStatementPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">
        Integritetspolicy
      </h1>
      <p className="mb-10 text-sm text-muted-foreground">
        Senast uppdaterad: 2026-07-05
      </p>

      <div className="flex flex-col gap-6 text-sm leading-7 text-foreground">
        <section>
          <h2 className="mb-2 text-lg font-medium">
            1. Uppgifter vi samlar in
          </h2>
          <p>
            <strong>Konto.</strong> När du skapar ett konto lagrar vi namn,
            e-postadress och, vid inloggning med e-post och lösenord, en hashad
            version av lösenordet. Loggar du in via Google eller Microsoft tar
            vi emot namn, e-post, eventuell profilbild och en kontoidentifierare
            från den leverantören. Vid registrering sparas även en hashad (ej
            läsbar) version av din IP-adress som skydd mot massregistrering.
          </p>
          <p className="mt-2">
            <strong>Konversationer.</strong> Dina frågor och Fiskargubbens svar
            sparas, tillsammans med en kort rubrik, vilken sjö eller vilket
            område konversationen gäller och den väderdata som svaret byggde på.
            Ställer du en fråga utan konto sparas konversationen anonymt och
            knyts till en slumpmässig kod i en kaka; skapar du konto senare
            flyttas den till ditt konto. För konversationer utan konto sparas
            även en hashad (ej läsbar) version av din IP-adress, som skydd mot
            missbruk av gratisfrågan.
          </p>
          <p className="mt-2">
            <strong>Plats.</strong> Endast om du aktivt väljer "Använd min
            plats". Koordinaterna används för att hitta sjöar och väderdata nära
            dig och sparas på den konversation de användes i. Själva valet
            (på/av) sparas som inställning på ditt konto respektive i din
            webbläsare.
          </p>
          <p className="mt-2">
            <strong>Användningsstatistik.</strong> Vi loggar tekniska händelser
            om hur tjänsten används, till exempel att en sjö kunde eller inte
            kunde identifieras eller att en datakälla inte svarade. Dessa
            händelser innehåller inte dina meddelanden.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">
            2. Kakor och lokal lagring
          </h2>
          <p>
            Vi använder en sessionskaka för inloggning och en kaka (fiska_claim)
            som knyter en anonym konversation till din webbläsare. I
            webbläsarens lokala lagring sparas dina val: om villkoren är
            godkända och om plats ska användas. Vi använder inga kakor för
            annonsering eller spårning över andra webbplatser.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">
            3. Tjänster och API:er vi använder
          </h2>
          <p>
            <strong>Anthropic (Claude).</strong> Dina meddelanden,
            konversationshistoriken och väderunderlaget skickas till Anthropics
            API för att generera Fiskargubbens svar. Enligt Anthropics
            API-villkor används sådan data inte för att träna deras modeller.
          </p>
          <p className="mt-2">
            <strong>Öppna datakällor.</strong> Väder- och sjöunderlaget hämtas
            från öppna svenska datakällor: SMHI:s öppna data (väderprognoser och
            väderobservationer), Lantmäteriets öppna kartdata (sjöregistret)
            samt SLU:s databaser (provfiskedata om arter och djup från
            NORS/Sötebasen och vattenkemi från miljödatabasen MVM). Inga
            personuppgifter skickas till dessa källor; anropen gäller sjöar och
            koordinater.
          </p>
          <p className="mt-2">
            <strong>Inloggning.</strong> Google och Microsoft kan användas för
            inloggning. Deras hantering av uppgifter styrs av deras egna
            integritetspolicyer.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">
            4. Hur uppgifterna används
          </h2>
          <p>
            Uppgifterna används enbart för att tillhandahålla tjänsten:
            autentisering, att spara och visa dina konversationer, att ge
            platsanpassade fiskeråd, kontohantering, missbruksskydd och support.
            Vi säljer inte dina uppgifter och delar dem inte med tredje part
            utöver vad som beskrivs ovan.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">5. Lagring och radering</h2>
          <p>
            Uppgifterna lagras så länge ditt konto är aktivt. Du kan när som
            helst radera ditt konto från profilsidan; då raderas kontot,
            sessioner och alla dina konversationer permanent.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">6. Dina rättigheter</h2>
          <p>
            Enligt GDPR har du rätt att få tillgång till, rätta eller radera
            dina uppgifter, samt att invända mot eller begränsa behandlingen.
            Kontakta oss för att utöva dessa rättigheter.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">7. Kontakt</h2>
          <p>
            Frågor om personuppgifter skickas till
            integritet@fragafiskargubben.se.
          </p>
        </section>
      </div>
    </main>
  );
}
