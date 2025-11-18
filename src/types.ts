/**
 * TypeScript typer for Brønnøysundregistrene Enhetsregisteret API
 * Basert på dokumentasjon: https://data.brreg.no/enhetsregisteret/api/dokumentasjon/no/index.html
 */

export interface Adresse {
  land?: string;
  landkode?: string;
  postnummer?: string;
  poststed?: string;
  adresse?: string[];
  kommune?: string;
  kommunenummer?: string;
}

export interface Naeringskode {
  kode?: string;
  beskrivelse?: string;
}

export interface Links {
  self?: {
    href: string;
  };
}

export interface Enhet {
  organisasjonsnummer: string;
  navn?: string;
  organisasjonsform?: {
    kode?: string;
    beskrivelse?: string;
  };
  registreringsdatoEnhetsregisteret?: string;
  registrertIMvaregisteret?: boolean;
  naeringskode1?: Naeringskode;
  naeringskode2?: Naeringskode;
  naeringskode3?: Naeringskode;
  antallAnsatte?: {
    fra?: number;
    til?: number;
    gruppe?: string;
  };
  forretningsadresse?: Adresse;
  postadresse?: Adresse;
  beliggenhetsadresse?: Adresse;
  stiftelsesdato?: string;
  registrertIFrivillighetsregisteret?: boolean;
  registrertIStiftelsesregisteret?: boolean;
  registrertIForeningsregisteret?: boolean;
  konkurs?: boolean;
  underAvvikling?: boolean;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  maalform?: string;
  _links?: Links;
  [key: string]: any; // For å tillate ekstra felter
}

export interface Oppdatering {
  organisasjonsnummer: string;
  endringstype: 'OPPRETTET' | 'ENDRET' | 'SLETTET';
  tidspunkt: string;
}

export interface ApiResponse<T> {
  _embedded?: {
    enheter?: T[];
    oppdateringer?: T[];
  };
  _links?: {
    self?: { href: string };
    first?: { href: string };
    next?: { href: string };
    last?: { href: string };
  };
  page?: {
    size?: number;
    totalElements?: number;
    totalPages?: number;
    number?: number;
  };
}

