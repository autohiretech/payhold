"""Generate src/lib/countries.ts — the world registry.

Data sources (checked August 2026):
  Stripe fully-supported countries : stripe.com/global
  Flutterwave channels + currencies: flutterwave.com/gb/support/payment-methods/payment-channels
  Flutterwave mobile money         : flutterwave.com/mw/support/payment-methods/pay-with-mobile-money
"""

# (code, name, currency, region)
COUNTRIES = [
    # --- Africa: North ------------------------------------------------------
    ("DZ", "Algeria", "DZD", "North Africa"),
    ("EG", "Egypt", "EGP", "North Africa"),
    ("LY", "Libya", "LYD", "North Africa"),
    ("MA", "Morocco", "MAD", "North Africa"),
    ("SD", "Sudan", "SDG", "North Africa"),
    ("TN", "Tunisia", "TND", "North Africa"),
    # --- Africa: West -------------------------------------------------------
    ("BJ", "Benin", "XOF", "West Africa"),
    ("BF", "Burkina Faso", "XOF", "West Africa"),
    ("CV", "Cabo Verde", "CVE", "West Africa"),
    ("CI", "Côte d'Ivoire", "XOF", "West Africa"),
    ("GM", "Gambia", "GMD", "West Africa"),
    ("GH", "Ghana", "GHS", "West Africa"),
    ("GN", "Guinea", "GNF", "West Africa"),
    ("GW", "Guinea-Bissau", "XOF", "West Africa"),
    ("LR", "Liberia", "LRD", "West Africa"),
    ("ML", "Mali", "XOF", "West Africa"),
    ("MR", "Mauritania", "MRU", "West Africa"),
    ("NE", "Niger", "XOF", "West Africa"),
    ("NG", "Nigeria", "NGN", "West Africa"),
    ("SN", "Senegal", "XOF", "West Africa"),
    ("SL", "Sierra Leone", "SLE", "West Africa"),
    ("TG", "Togo", "XOF", "West Africa"),
    # --- Africa: Central ----------------------------------------------------
    ("CM", "Cameroon", "XAF", "Central Africa"),
    ("CF", "Central African Republic", "XAF", "Central Africa"),
    ("TD", "Chad", "XAF", "Central Africa"),
    ("CG", "Congo", "XAF", "Central Africa"),
    ("CD", "DR Congo", "CDF", "Central Africa"),
    ("GQ", "Equatorial Guinea", "XAF", "Central Africa"),
    ("GA", "Gabon", "XAF", "Central Africa"),
    ("ST", "São Tomé and Príncipe", "STN", "Central Africa"),
    # --- Africa: East -------------------------------------------------------
    ("BI", "Burundi", "BIF", "East Africa"),
    ("KM", "Comoros", "KMF", "East Africa"),
    ("DJ", "Djibouti", "DJF", "East Africa"),
    ("ER", "Eritrea", "ERN", "East Africa"),
    ("ET", "Ethiopia", "ETB", "East Africa"),
    ("KE", "Kenya", "KES", "East Africa"),
    ("MG", "Madagascar", "MGA", "East Africa"),
    ("MU", "Mauritius", "MUR", "East Africa"),
    ("RW", "Rwanda", "RWF", "East Africa"),
    ("SC", "Seychelles", "SCR", "East Africa"),
    ("SO", "Somalia", "SOS", "East Africa"),
    ("SS", "South Sudan", "SSP", "East Africa"),
    ("TZ", "Tanzania", "TZS", "East Africa"),
    ("UG", "Uganda", "UGX", "East Africa"),
    # --- Africa: Southern ---------------------------------------------------
    ("AO", "Angola", "AOA", "Southern Africa"),
    ("BW", "Botswana", "BWP", "Southern Africa"),
    ("SZ", "Eswatini", "SZL", "Southern Africa"),
    ("LS", "Lesotho", "LSL", "Southern Africa"),
    ("MW", "Malawi", "MWK", "Southern Africa"),
    ("MZ", "Mozambique", "MZN", "Southern Africa"),
    ("NA", "Namibia", "NAD", "Southern Africa"),
    ("ZA", "South Africa", "ZAR", "Southern Africa"),
    ("ZM", "Zambia", "ZMW", "Southern Africa"),
    ("ZW", "Zimbabwe", "ZWG", "Southern Africa"),
    # --- Europe -------------------------------------------------------------
    ("AL", "Albania", "ALL", "Europe"),
    ("AD", "Andorra", "EUR", "Europe"),
    ("AT", "Austria", "EUR", "Europe"),
    ("BY", "Belarus", "BYN", "Europe"),
    ("BE", "Belgium", "EUR", "Europe"),
    ("BA", "Bosnia and Herzegovina", "BAM", "Europe"),
    ("BG", "Bulgaria", "BGN", "Europe"),
    ("HR", "Croatia", "EUR", "Europe"),
    ("CY", "Cyprus", "EUR", "Europe"),
    ("CZ", "Czechia", "CZK", "Europe"),
    ("DK", "Denmark", "DKK", "Europe"),
    ("EE", "Estonia", "EUR", "Europe"),
    ("FI", "Finland", "EUR", "Europe"),
    ("FR", "France", "EUR", "Europe"),
    ("DE", "Germany", "EUR", "Europe"),
    ("GI", "Gibraltar", "GIP", "Europe"),
    ("GR", "Greece", "EUR", "Europe"),
    ("HU", "Hungary", "HUF", "Europe"),
    ("IS", "Iceland", "ISK", "Europe"),
    ("IE", "Ireland", "EUR", "Europe"),
    ("IT", "Italy", "EUR", "Europe"),
    ("LV", "Latvia", "EUR", "Europe"),
    ("LI", "Liechtenstein", "CHF", "Europe"),
    ("LT", "Lithuania", "EUR", "Europe"),
    ("LU", "Luxembourg", "EUR", "Europe"),
    ("MT", "Malta", "EUR", "Europe"),
    ("MD", "Moldova", "MDL", "Europe"),
    ("MC", "Monaco", "EUR", "Europe"),
    ("ME", "Montenegro", "EUR", "Europe"),
    ("NL", "Netherlands", "EUR", "Europe"),
    ("MK", "North Macedonia", "MKD", "Europe"),
    ("NO", "Norway", "NOK", "Europe"),
    ("PL", "Poland", "PLN", "Europe"),
    ("PT", "Portugal", "EUR", "Europe"),
    ("RO", "Romania", "RON", "Europe"),
    ("RU", "Russia", "RUB", "Europe"),
    ("SM", "San Marino", "EUR", "Europe"),
    ("RS", "Serbia", "RSD", "Europe"),
    ("SK", "Slovakia", "EUR", "Europe"),
    ("SI", "Slovenia", "EUR", "Europe"),
    ("ES", "Spain", "EUR", "Europe"),
    ("SE", "Sweden", "SEK", "Europe"),
    ("CH", "Switzerland", "CHF", "Europe"),
    ("UA", "Ukraine", "UAH", "Europe"),
    ("GB", "United Kingdom", "GBP", "Europe"),
    # --- Middle East --------------------------------------------------------
    ("BH", "Bahrain", "BHD", "Middle East"),
    ("IR", "Iran", "IRR", "Middle East"),
    ("IQ", "Iraq", "IQD", "Middle East"),
    ("IL", "Israel", "ILS", "Middle East"),
    ("JO", "Jordan", "JOD", "Middle East"),
    ("KW", "Kuwait", "KWD", "Middle East"),
    ("LB", "Lebanon", "LBP", "Middle East"),
    ("OM", "Oman", "OMR", "Middle East"),
    ("PS", "Palestine", "ILS", "Middle East"),
    ("QA", "Qatar", "QAR", "Middle East"),
    ("SA", "Saudi Arabia", "SAR", "Middle East"),
    ("SY", "Syria", "SYP", "Middle East"),
    ("TR", "Türkiye", "TRY", "Middle East"),
    ("AE", "United Arab Emirates", "AED", "Middle East"),
    ("YE", "Yemen", "YER", "Middle East"),
    # --- Asia ---------------------------------------------------------------
    ("AF", "Afghanistan", "AFN", "Asia"),
    ("AM", "Armenia", "AMD", "Asia"),
    ("AZ", "Azerbaijan", "AZN", "Asia"),
    ("BD", "Bangladesh", "BDT", "Asia"),
    ("BT", "Bhutan", "BTN", "Asia"),
    ("BN", "Brunei", "BND", "Asia"),
    ("KH", "Cambodia", "KHR", "Asia"),
    ("CN", "China", "CNY", "Asia"),
    ("GE", "Georgia", "GEL", "Asia"),
    ("HK", "Hong Kong", "HKD", "Asia"),
    ("IN", "India", "INR", "Asia"),
    ("ID", "Indonesia", "IDR", "Asia"),
    ("JP", "Japan", "JPY", "Asia"),
    ("KZ", "Kazakhstan", "KZT", "Asia"),
    ("KG", "Kyrgyzstan", "KGS", "Asia"),
    ("LA", "Laos", "LAK", "Asia"),
    ("MO", "Macao", "MOP", "Asia"),
    ("MY", "Malaysia", "MYR", "Asia"),
    ("MV", "Maldives", "MVR", "Asia"),
    ("MN", "Mongolia", "MNT", "Asia"),
    ("MM", "Myanmar", "MMK", "Asia"),
    ("NP", "Nepal", "NPR", "Asia"),
    ("KP", "North Korea", "KPW", "Asia"),
    ("PK", "Pakistan", "PKR", "Asia"),
    ("PH", "Philippines", "PHP", "Asia"),
    ("SG", "Singapore", "SGD", "Asia"),
    ("KR", "South Korea", "KRW", "Asia"),
    ("LK", "Sri Lanka", "LKR", "Asia"),
    ("TW", "Taiwan", "TWD", "Asia"),
    ("TJ", "Tajikistan", "TJS", "Asia"),
    ("TH", "Thailand", "THB", "Asia"),
    ("TL", "Timor-Leste", "USD", "Asia"),
    ("TM", "Turkmenistan", "TMT", "Asia"),
    ("UZ", "Uzbekistan", "UZS", "Asia"),
    ("VN", "Vietnam", "VND", "Asia"),
    # --- Oceania ------------------------------------------------------------
    ("AU", "Australia", "AUD", "Oceania"),
    ("FJ", "Fiji", "FJD", "Oceania"),
    ("KI", "Kiribati", "AUD", "Oceania"),
    ("MH", "Marshall Islands", "USD", "Oceania"),
    ("FM", "Micronesia", "USD", "Oceania"),
    ("NR", "Nauru", "AUD", "Oceania"),
    ("NZ", "New Zealand", "NZD", "Oceania"),
    ("PW", "Palau", "USD", "Oceania"),
    ("PG", "Papua New Guinea", "PGK", "Oceania"),
    ("WS", "Samoa", "WST", "Oceania"),
    ("SB", "Solomon Islands", "SBD", "Oceania"),
    ("TO", "Tonga", "TOP", "Oceania"),
    ("TV", "Tuvalu", "AUD", "Oceania"),
    ("VU", "Vanuatu", "VUV", "Oceania"),
    # --- North America and the Caribbean ------------------------------------
    ("AG", "Antigua and Barbuda", "XCD", "North America"),
    ("BS", "Bahamas", "BSD", "North America"),
    ("BB", "Barbados", "BBD", "North America"),
    ("BZ", "Belize", "BZD", "North America"),
    ("CA", "Canada", "CAD", "North America"),
    ("CR", "Costa Rica", "CRC", "North America"),
    ("CU", "Cuba", "CUP", "North America"),
    ("DM", "Dominica", "XCD", "North America"),
    ("DO", "Dominican Republic", "DOP", "North America"),
    ("SV", "El Salvador", "USD", "North America"),
    ("GD", "Grenada", "XCD", "North America"),
    ("GT", "Guatemala", "GTQ", "North America"),
    ("HT", "Haiti", "HTG", "North America"),
    ("HN", "Honduras", "HNL", "North America"),
    ("JM", "Jamaica", "JMD", "North America"),
    ("MX", "Mexico", "MXN", "North America"),
    ("NI", "Nicaragua", "NIO", "North America"),
    ("PA", "Panama", "PAB", "North America"),
    ("KN", "Saint Kitts and Nevis", "XCD", "North America"),
    ("LC", "Saint Lucia", "XCD", "North America"),
    ("VC", "Saint Vincent and the Grenadines", "XCD", "North America"),
    ("TT", "Trinidad and Tobago", "TTD", "North America"),
    ("US", "United States", "USD", "North America"),
    # --- South America ------------------------------------------------------
    ("AR", "Argentina", "ARS", "South America"),
    ("BO", "Bolivia", "BOB", "South America"),
    ("BR", "Brazil", "BRL", "South America"),
    ("CL", "Chile", "CLP", "South America"),
    ("CO", "Colombia", "COP", "South America"),
    ("EC", "Ecuador", "USD", "South America"),
    ("GY", "Guyana", "GYD", "South America"),
    ("PY", "Paraguay", "PYG", "South America"),
    ("PE", "Peru", "PEN", "South America"),
    ("SR", "Suriname", "SRD", "South America"),
    ("UY", "Uruguay", "UYU", "South America"),
    ("VE", "Venezuela", "VES", "South America"),
]

# Stripe: fully available for a business account with payouts. stripe.com/global.
STRIPE_PAYOUT = {
    "AU", "AT", "BE", "BR", "BG", "CA", "HR", "CY", "CZ", "DK", "EE", "FI",
    "FR", "DE", "GI", "GR", "HK", "HU", "IE", "IT", "JP", "LV", "LI", "LT",
    "LU", "MY", "MT", "MX", "NL", "NZ", "NO", "PL", "PT", "RO", "SG", "SK",
    "SI", "ES", "SE", "CH", "TH", "AE", "GB", "US",
}

# Stripe "Preview" — contact sales, not generally available.
STRIPE_PREVIEW = {"IN", "ID"}

# Flutterwave local-currency collection, from its published channel list.
FLUTTERWAVE_LOCAL = {
    "NG", "GH", "KE", "UG", "RW", "TZ", "ZA", "ZM", "MW", "EG", "SL",
    # XOF zone
    "BJ", "BF", "CI", "GW", "ML", "NE", "SN", "TG",
    # XAF zone
    "CM", "CF", "TD", "CG", "GQ", "GA",
}

# Mobile money, with the wallets Flutterwave names per market.
MOMO = {
    "BF": ["Orange Money", "Mobicash"],
    "CI": ["MTN", "Orange Money", "Wave"],
    "CM": ["MTN", "Orange Money"],
    "GH": ["MTN", "Telecel", "AirtelTigo"],
    "KE": ["M-Pesa"],
    "MW": [],  # documented as a channel; networks not named by Flutterwave
    "RW": ["MTN", "Airtel Money"],
    "SN": ["Orange Money", "Free Money", "Wave"],
    "TZ": ["Airtel Money", "Tigo Pesa", "HaloPesa"],
    "UG": ["MTN", "Airtel Money"],
    "ZM": ["MTN", "Airtel Money", "Zamtel"],
}

# Comprehensively sanctioned or embargoed. No acquirer will process a card
# here, so claiming universal coverage would be a lie. Needs legal review.
RESTRICTED = {"CU", "IR", "KP", "SY", "RU", "BY"}

# ISO-4217 currencies with no minor unit.
ZERO_DECIMAL = {
    "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
    "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
}


def ts_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main() -> None:
    codes = [row[0] for row in COUNTRIES]
    assert len(codes) == len(set(codes)), "duplicate country code"

    currencies = sorted({row[2] for row in COUNTRIES} | {"USD", "EUR", "GBP"})
    regions = []
    for row in COUNTRIES:
        if row[3] not in regions:
            regions.append(row[3])

    out = []
    w = out.append

    w('''/**
 * Every country in the world, and what each provider can actually do there.
 *
 * GENERATED FILE — see scripts/gen-countries.py. Edit the generator, not this.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two facts shape everything downstream:
 *
 *   1. **Card acquiring is near-universal.** A card issued in Vanuatu can be
 *      charged by a Stripe merchant even though Stripe has no presence there.
 *      So almost every country can pay — `restricted` marks the handful where
 *      sanctions mean no acquirer will process, and nothing else.
 *
 *   2. **Paying out is licensed per corridor, and narrow.** Stripe reaches 44
 *      countries. Flutterwave reaches its African markets. Between them that
 *      is well under half the world, and the rest can pay but cannot be paid.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sources, checked August 2026 — re-check before launch, coverage changes:
 *   stripe.com/global
 *   flutterwave.com/gb/support/payment-methods/payment-channels
 *   flutterwave.com/mw/support/payment-methods/pay-with-mobile-money
 *   flutterwave.com/mu/support/general/what-are-the-currencies-accepted-on-flutterwave
 *
 * Nothing here is verified against a signed provider agreement. See
 * `RAILS_VERIFIED` in rails.ts.
 */
''')

    w("export interface CountryInfo {")
    w("  code: Country")
    w("  name: string")
    w("  /** ISO-4217 code of the local currency. */")
    w("  currency: Currency")
    w("  region: Region")
    w("  /** Flutterwave supports collection in this country's own currency. */")
    w("  flutterwaveLocal: boolean")
    w("  /** Mobile money is available here. */")
    w("  momo: boolean")
    w("  /** Named wallets. Empty with `momo: true` means the list is unconfirmed. */")
    w("  momoNetworks: string[]")
    w("  /** Flutterwave can send funds to a beneficiary here. */")
    w("  flutterwavePayout: boolean")
    w("  /** Stripe supports a business account with payouts here. */")
    w("  stripePayout: boolean")
    w("  /** Stripe lists this market as preview / contact-sales only. */")
    w("  stripePreview: boolean")
    w("  /** Sanctioned or embargoed — no card acquirer will process. */")
    w("  restricted: boolean")
    w("}")
    w("")

    w("export type Region =")
    for i, region in enumerate(regions):
        w(f"  {'|' if i else '|'} {ts_string(region)}")
    w("")

    w("export const REGIONS: Region[] = [")
    for region in regions:
        w(f"  {ts_string(region)},")
    w("]")
    w("")

    w("/** ISO-3166 alpha-2 for every country PayHold knows about. */")
    w("export type Country =")
    for i in range(0, len(codes), 10):
        chunk = " | ".join(ts_string(code) for code in codes[i : i + 10])
        w(f"  | {chunk}")
    w("")

    w("/** ISO-4217 for every currency any of those countries uses. */")
    w("export type Currency =")
    for i in range(0, len(currencies), 10):
        chunk = " | ".join(ts_string(cur) for cur in currencies[i : i + 10])
        w(f"  | {chunk}")
    w("")

    w("export const COUNTRIES: CountryInfo[] = [")
    current_region = None
    for code, name, currency, region in COUNTRIES:
        if region != current_region:
            w(f"  // --- {region} " + "-" * max(4, 66 - len(region)))
            current_region = region
        networks = MOMO.get(code)
        fields = [
            f"code: {ts_string(code)}",
            f"name: {ts_string(name)}",
            f"currency: {ts_string(currency)}",
            f"region: {ts_string(region)}",
            f"flutterwaveLocal: {'true' if code in FLUTTERWAVE_LOCAL else 'false'}",
            f"momo: {'true' if networks is not None else 'false'}",
            "momoNetworks: ["
            + ", ".join(ts_string(n) for n in (networks or []))
            + "]",
            f"flutterwavePayout: {'true' if code in FLUTTERWAVE_LOCAL else 'false'}",
            f"stripePayout: {'true' if code in STRIPE_PAYOUT else 'false'}",
            f"stripePreview: {'true' if code in STRIPE_PREVIEW else 'false'}",
            f"restricted: {'true' if code in RESTRICTED else 'false'}",
        ]
        w("  { " + ", ".join(fields) + " },")
    w("]")
    w("")

    w("/** Currencies with no minor unit — never render a decimal point. */")
    w("export const ZERO_DECIMAL_CURRENCIES: Currency[] = [")
    for cur in sorted(ZERO_DECIMAL & set(currencies)):
        w(f"  {ts_string(cur)},")
    w("]")
    w("")

    w('''const BY_CODE = new Map(COUNTRIES.map((info) => [info.code, info]))

export function countryInfo(code: Country): CountryInfo {
  const info = BY_CODE.get(code)
  if (!info) throw new Error(`Unknown country: ${code}`)
  return info
}

export function countryName(code: Country): string {
  return BY_CODE.get(code)?.name ?? code
}

/** Grouped for a picker — a flat list of nearly 200 is unusable. */
export function countriesByRegion(): { region: string; countries: CountryInfo[] }[] {
  return REGIONS.map((region) => ({
    region,
    countries: COUNTRIES.filter((info) => info.region === region),
  })).filter((group) => group.countries.length > 0)
}
''')

    text = "\n".join(out) + "\n"
    with open("src/lib/countries.ts", "w") as fh:
        fh.write(text)

    print(f"{len(COUNTRIES)} countries, {len(currencies)} currencies")
    print(f"  stripe payout   : {len(STRIPE_PAYOUT)}")
    print(f"  flutterwave     : {len(FLUTTERWAVE_LOCAL)}")
    print(f"  mobile money    : {len(MOMO)}")
    print(f"  restricted      : {len(RESTRICTED)}")


if __name__ == "__main__":
    main()
