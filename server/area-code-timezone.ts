/**
 * AREA CODE → TIMEZONE LOOKUP
 *
 * Maps US phone area codes to IANA timezone identifiers.
 * Used for TCPA quiet hours compliance — SMS must not be sent
 * before 9 AM or after 9 PM in the RECIPIENT's local timezone.
 *
 * Falls back to America/New_York (ET) for unknown area codes.
 *
 * Coverage: ~300 most common US area codes covering all 4 continental
 * time zones (ET, CT, MT, PT) plus Alaska and Hawaii.
 */

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const PT = "America/Los_Angeles";
const AK = "America/Anchorage";
const HI = "Pacific/Honolulu";

/**
 * Area code → timezone mapping.
 * For area codes that span multiple timezones, we use the majority timezone.
 * Sources: NANPA, FCC area code assignments.
 */
const AREA_CODE_TZ: Record<string, string> = {
  // === EASTERN TIME (ET) ===
  // Connecticut
  "203": ET, "475": ET, "860": ET,
  // Delaware
  "302": ET,
  // District of Columbia
  "202": ET,
  // Florida (most)
  "239": ET, "305": ET, "321": ET, "352": ET, "386": ET, "407": ET,
  "561": ET, "689": ET, "727": ET, "754": ET, "772": ET, "786": ET,
  "813": ET, "863": ET, "904": ET, "941": ET, "954": ET,
  // Georgia
  "229": ET, "404": ET, "470": ET, "478": ET, "678": ET, "706": ET,
  "762": ET, "770": ET, "912": ET, "943": ET,
  // Maine
  "207": ET,
  // Maryland
  "240": ET, "301": ET, "410": ET, "443": ET, "667": ET,
  // Massachusetts
  "339": ET, "351": ET, "413": ET, "508": ET, "617": ET, "774": ET,
  "781": ET, "857": ET, "978": ET,
  // Michigan (most — Detroit area)
  "231": ET, "248": ET, "269": ET, "313": ET, "517": ET, "586": ET,
  "616": ET, "734": ET, "810": ET, "947": ET, "989": ET,
  // New Hampshire
  "603": ET,
  // New Jersey
  "201": ET, "551": ET, "609": ET, "732": ET, "848": ET, "856": ET,
  "862": ET, "908": ET, "973": ET,
  // New York
  "212": ET, "315": ET, "332": ET, "347": ET, "516": ET, "518": ET,
  "585": ET, "607": ET, "631": ET, "646": ET, "680": ET, "716": ET,
  "718": ET, "838": ET, "845": ET, "914": ET, "917": ET, "929": ET,
  "934": ET,
  // North Carolina
  "252": ET, "336": ET, "704": ET, "743": ET, "828": ET, "910": ET,
  "919": ET, "980": ET, "984": ET,
  // Ohio
  "216": ET, "220": ET, "234": ET, "283": ET, "326": ET, "330": ET,
  "380": ET, "419": ET, "440": ET, "513": ET, "567": ET, "614": ET,
  "740": ET, "937": ET,
  // Pennsylvania
  "215": ET, "223": ET, "267": ET, "272": ET, "412": ET, "445": ET,
  "484": ET, "570": ET, "582": ET, "610": ET, "717": ET, "724": ET,
  "814": ET, "835": ET, "878": ET,
  // Rhode Island
  "401": ET,
  // South Carolina
  "803": ET, "839": ET, "843": ET, "854": ET, "864": ET,
  // Vermont
  "802": ET,
  // Virginia
  "276": ET, "434": ET, "540": ET, "571": ET, "703": ET, "757": ET,
  "804": ET,
  // West Virginia
  "304": ET, "681": ET,
  // Puerto Rico / US Virgin Islands
  "787": ET, "939": ET, "340": ET,

  // === CENTRAL TIME (CT) ===
  // Alabama
  "205": CT, "251": CT, "256": CT, "334": CT, "659": CT, "938": CT,
  // Arkansas
  "479": CT, "501": CT, "870": CT,
  // Florida panhandle (Central Time)
  "850": CT,
  // Illinois
  "217": CT, "224": CT, "309": CT, "312": CT, "331": CT, "447": CT,
  "464": CT, "618": CT, "630": CT, "708": CT, "773": CT, "779": CT,
  "815": CT, "847": CT, "872": CT,
  // Indiana (most — Indianapolis area)
  "219": CT, "260": CT, "317": CT, "463": CT, "574": CT, "765": CT,
  "812": CT, "930": CT,
  // Iowa
  "319": CT, "515": CT, "563": CT, "641": CT, "712": CT,
  // Kansas
  "316": CT, "620": CT, "785": CT, "913": CT,
  // Kentucky
  "270": CT, "364": CT, "502": CT, "606": ET, "859": ET,
  // Louisiana
  "225": CT, "318": CT, "337": CT, "504": CT, "985": CT,
  // Minnesota
  "218": CT, "320": CT, "507": CT, "612": CT, "651": CT, "763": CT,
  "952": CT,
  // Mississippi
  "228": CT, "601": CT, "662": CT, "769": CT,
  // Missouri
  "314": CT, "417": CT, "573": CT, "636": CT, "660": CT, "816": CT,
  // Nebraska
  "308": CT, "402": CT, "531": CT,
  // North Dakota
  "701": CT,
  // Oklahoma
  "405": CT, "539": CT, "580": CT, "918": CT,
  // South Dakota
  "605": CT,
  // Tennessee
  "423": ET, "615": CT, "629": CT, "731": CT, "865": ET, "901": CT,
  "931": CT,
  // Texas
  "210": CT, "214": CT, "254": CT, "281": CT, "325": CT, "346": CT,
  "361": CT, "409": CT, "430": CT, "432": CT, "469": CT, "512": CT,
  "682": CT, "713": CT, "726": CT, "737": CT, "806": CT, "817": CT,
  "830": CT, "832": CT, "903": CT, "915": MT, "936": CT, "940": CT,
  "956": CT, "972": CT, "979": CT,
  // Wisconsin
  "262": CT, "274": CT, "414": CT, "534": CT, "608": CT, "715": CT,
  "920": CT,

  // === MOUNTAIN TIME (MT) ===
  // Arizona (no DST — uses MST year-round)
  "480": MT, "520": MT, "602": MT, "623": MT, "928": MT,
  // Colorado
  "303": MT, "719": MT, "720": MT, "970": MT,
  // Idaho
  "208": MT,
  // Montana
  "406": MT,
  // New Mexico
  "505": MT, "575": MT,
  // Utah
  "385": MT, "435": MT, "801": MT,
  // Wyoming
  "307": MT,

  // === PACIFIC TIME (PT) ===
  // California
  "209": PT, "213": PT, "279": PT, "310": PT, "323": PT, "341": PT,
  "350": PT, "408": PT, "415": PT, "424": PT, "442": PT, "510": PT,
  "530": PT, "559": PT, "562": PT, "619": PT, "626": PT, "628": PT,
  "650": PT, "657": PT, "661": PT, "669": PT, "707": PT, "714": PT,
  "747": PT, "760": PT, "805": PT, "818": PT, "831": PT, "858": PT,
  "909": PT, "916": PT, "925": PT, "949": PT, "951": PT,
  // Nevada
  "702": PT, "725": PT, "775": PT,
  // Oregon
  "458": PT, "503": PT, "541": PT, "971": PT,
  // Washington
  "206": PT, "253": PT, "360": PT, "425": PT, "509": PT, "564": PT,

  // === ALASKA ===
  "907": AK,

  // === HAWAII ===
  "808": HI,
};

/**
 * Get the IANA timezone for a US phone number based on area code.
 * Falls back to America/New_York if the area code is unknown or non-US.
 */
export function getTimezoneForPhone(phone: string | null | undefined): string {
  if (!phone) return ET;

  // Strip +1 prefix and any non-digit characters
  const digits = phone.replace(/\D/g, "");
  let areaCode: string;

  if (digits.startsWith("1") && digits.length >= 4) {
    areaCode = digits.substring(1, 4);
  } else if (digits.length >= 3) {
    areaCode = digits.substring(0, 3);
  } else {
    return ET; // Too short to determine
  }

  return AREA_CODE_TZ[areaCode] || ET;
}

/**
 * Check if it's currently TCPA quiet hours in the RECIPIENT's timezone.
 * SMS must not be sent before 9 AM or after 9 PM in the recipient's local time.
 *
 * @param phone - The recipient's phone number (used to determine timezone)
 * @param date - The date/time to check (defaults to now)
 * @returns true if SMS should NOT be sent (quiet hours)
 */
export function isTcpaQuietHoursForRecipient(
  phone: string | null | undefined,
  date: Date = new Date()
): boolean {
  const tz = getTimezoneForPhone(phone);
  const localStr = date.toLocaleString("en-US", { timeZone: tz });
  const localDate = new Date(localStr);
  const hour = localDate.getHours();
  return hour < 9 || hour >= 21;
}

/**
 * Get the next 9 AM in the recipient's timezone.
 * Used to schedule deferred SMS sends.
 */
export function nextTcpaWindowForRecipient(
  phone: string | null | undefined,
  date: Date = new Date()
): Date {
  const tz = getTimezoneForPhone(phone);
  const localStr = date.toLocaleString("en-US", { timeZone: tz });
  const localDate = new Date(localStr);
  const hour = localDate.getHours();

  if (hour >= 21) {
    localDate.setDate(localDate.getDate() + 1);
  }
  localDate.setHours(9, 0, 0, 0);

  // Convert back to UTC-equivalent Date
  // localDate is in the recipient's local time; we need to offset back
  const nowLocal = new Date(date.toLocaleString("en-US", { timeZone: tz }));
  const offsetMs = date.getTime() - nowLocal.getTime();
  return new Date(localDate.getTime() + offsetMs);
}
