/* =====================================================================
   SCHOOLS: campuses the app can switch between
   ===================================================================== */

export const SCHOOLS = {
  berkeley: {
    id: "berkeley",
    name: "UC Berkeley",
    shortName: "Berkeley",
    timezone: "America/Los_Angeles",
    dataBase: "data/berkeley/",
    emailDomains: ["berkeley.edu"],
    sourceLabel: "Berkeley Dining",
  },
  ucla: {
    id: "ucla",
    name: "UCLA",
    shortName: "UCLA",
    timezone: "America/Los_Angeles",
    dataBase: "data/ucla/",
    emailDomains: ["ucla.edu", "g.ucla.edu"],
    sourceLabel: "UCLA Dining",
  },
  ucsd: {
    id: "ucsd",
    name: "UC San Diego",
    shortName: "UCSD",
    timezone: "America/Los_Angeles",
    dataBase: "data/ucsd/",
    emailDomains: ["ucsd.edu"],
    sourceLabel: "UCSD HDH Dining",
  },
  uci: {
    id: "uci",
    name: "UC Irvine",
    shortName: "UCI",
    timezone: "America/Los_Angeles",
    dataBase: "data/uci/",
    emailDomains: ["uci.edu"],
    sourceLabel: "UCI Dining",
  },
  ucsb: {
    id: "ucsb",
    name: "UC Santa Barbara",
    shortName: "UCSB",
    timezone: "America/Los_Angeles",
    dataBase: "data/ucsb/",
    emailDomains: ["ucsb.edu"],
    sourceLabel: "UCSB Campus Dining",
  },
  ucd: {
    id: "ucd",
    name: "UC Davis",
    shortName: "UCD",
    timezone: "America/Los_Angeles",
    dataBase: "data/ucd/",
    emailDomains: ["ucdavis.edu"],
    sourceLabel: "UC Davis Dining",
  },
  ucsc: {
    id: "ucsc",
    name: "UC Santa Cruz",
    shortName: "UCSC",
    timezone: "America/Los_Angeles",
    dataBase: "data/ucsc/",
    emailDomains: ["ucsc.edu"],
    sourceLabel: "UCSC Dining",
  },
};

export const SCHOOL_ORDER = ["berkeley", "ucla", "ucsd", "uci", "ucsb", "ucd", "ucsc"];

export function getSchool(id) {
  return SCHOOLS[id] || SCHOOLS.berkeley;
}

/** All email domains accepted across every campus. */
export function allEmailDomains() {
  const out = [];
  for (const id of SCHOOL_ORDER) {
    for (const d of SCHOOLS[id].emailDomains) {
      if (!out.includes(d)) out.push(d);
    }
  }
  return out;
}
