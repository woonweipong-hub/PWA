// SiteShrimp v2 — Shared Constants
// Entry types, statuses, severities, roles, components, location presets

// ── Entry Types ──────────────────────────────────────────────────
const ENTRY_TYPES = ["Observation", "Defect", "Update", "Instruction"];
const ENTRY_TYPE_ICON = { Observation: "\u{1F441}", Defect: "\u26A0\uFE0F", Update: "\u{1F504}", Instruction: "\u{1F4CB}" };
const ENTRY_TYPE_COLOR = { Observation: "#34aadc", Defect: "#ff3b30", Update: "#ff9500", Instruction: "#5856d6" };
const ENTRY_TYPE_BG = { Observation: "rgba(52,170,220,0.12)", Defect: "rgba(255,59,48,0.12)", Update: "rgba(255,149,0,0.12)", Instruction: "rgba(88,86,214,0.12)" };

// Palette for custom entry types (cycles through these)
const CUSTOM_TYPE_COLORS = ["#e91e63","#9c27b0","#00bcd4","#4caf50","#795548","#607d8b","#ff5722","#3f51b5"];
const CUSTOM_TYPE_ICONS = ["\u{1F4DD}","\u{1F50D}","\u{1F3D7}","\u2705","\u{1F6E1}","\u{1F4CA}","\u{1F527}","\u{1F4CC}"];
const CUSTOM_TYPES_KEY = "sdt-custom-types-v1";

// ── Severity ─────────────────────────────────────────────────────
const SEVERITY = ["Critical", "Major", "Minor", "Observation"];
const SEV_COLOR = { Critical: "#ff3b30", Major: "#ff9500", Minor: "#e6b800", Observation: "#34aadc" };
const SEV_BG = { Critical: "rgba(255,59,48,0.12)", Major: "rgba(255,149,0,0.12)", Minor: "rgba(230,184,0,0.12)", Observation: "rgba(52,170,220,0.12)" };

// ── Status Workflow: Open → In Progress → Done → Verified → Closed
const STATUS = ["Open", "In Progress", "Done", "Verified", "Closed"];
const STATUS_COLOR = {
  Open: "#ff3b30",
  "In Progress": "#ff9500",
  Done: "#34aadc",
  Verified: "#30d158",
  Closed: "#8e8e93"
};
const STATUS_ICON = {
  Open: "\u{1F534}",
  "In Progress": "\u{1F7E1}",
  Done: "\u{1F535}",
  Verified: "\u{1F7E2}",
  Closed: "\u26AA"
};

// ── Roles & Permissions ──────────────────────────────────────────
const ROLES = ["Admin", "Manager", "Inspector", "Viewer"];
const ROLE_COLOR = { Admin: "#ff3b30", Manager: "#ff9500", Inspector: "#34aadc", Viewer: "#8e8e93" };
const JOB_TITLES = [
  "Site Manager", "Project Manager", "Engineer", "Contractor",
  "QC Inspector", "Safety Officer", "Supervisor", "Architect",
  "Foreman", "Resident", "Homeowner", "Other"
];

// Permission helpers
const PERMS = {
  canCreateEntry: (role, entryType) => {
    if (role === "Viewer") return false;
    if (entryType === "Instruction") return ["Admin", "Manager"].includes(role);
    return ["Admin", "Manager", "Inspector"].includes(role);
  },
  canUpdateEntry: (role, isOwner) => {
    if (["Admin", "Manager"].includes(role)) return true;
    if (role === "Inspector" && isOwner) return true;
    return false;
  },
  canChangeStatus: (role, fromStatus, toStatus) => {
    if (role === "Admin") return true; // Admin can do anything
    if (role === "Viewer") return false;
    // Forward transitions
    if (fromStatus === "Open" && toStatus === "In Progress") return true;
    if (fromStatus === "In Progress" && toStatus === "Done") return true;
    if (toStatus === "Verified") return ["Admin", "Manager"].includes(role);
    if (toStatus === "Closed") return role === "Admin";
    return false;
  },
  canDeleteEntry: (role) => role === "Admin",
  canUploadDrawing: (role) => ["Admin", "Manager"].includes(role),
  canManageTeam: (role) => role === "Admin",
  canManageProjects: (role) => ["Admin", "Manager"].includes(role),
  canExport: (role) => ["Admin", "Manager"].includes(role),
  canComment: (role) => role !== "Viewer",
};

// ── Component Groups (for grouped selection UI) ──────────────────
const COMPONENT_GROUPS = {
  "Structural": ["Column", "Beam", "Slab", "Foundation", "Retaining Wall", "Shear Wall", "Pile Cap"],
  "Architectural": ["Wall", "Door", "Window", "Floor", "Ceiling", "Roof", "Staircase", "Railing", "Balcony", "Corridor", "Parapet", "Facade", "Canopy"],
  "M&E – Plumbing": ["Pipe", "Drain", "Tap/Faucet", "Water Heater", "Toilet/WC", "Basin/Sink", "Bathtub/Shower", "Floor Trap", "Valve"],
  "M&E – Electrical": ["Wiring", "Socket/Outlet", "Switch", "Light Fixture", "Distribution Board", "Cable Tray", "Earth/Grounding"],
  "M&E – ACMV": ["AC Unit", "FCU", "AHU", "Duct", "Diffuser/Grille", "Thermostat", "Condensate Pipe", "Chiller"],
  "M&E – Fire": ["Sprinkler", "Fire Alarm", "Extinguisher", "Hose Reel", "Smoke Detector", "Emergency Light", "Exit Sign"],
  "M&E – Lift": ["Lift Car", "Lift Door", "Lift Shaft", "Lift Motor", "Lift Button/Panel"],
  "Finishes": ["Tile", "Paint", "Plaster", "Waterproofing", "Skirting", "Cornice", "Cove", "Wallpaper", "Epoxy", "Screed"],
  "Carpentry": ["Cabinet", "Wardrobe", "Countertop", "Shelf", "Vanity", "Door Frame", "Window Frame", "Timber Deck"],
  "Sanitary": ["Toilet Bowl", "Urinal", "Basin", "Bidet", "Mirror", "Toilet Accessories", "Towel Rail"],
  "External/Landscape": ["External Wall", "Driveway", "Walkway", "Drain/Gutter", "Garden/Planting", "Fence/Gate", "Car Park", "Swimming Pool", "Playground", "Retaining Wall"],
  "General": ["General", "Other"],
};

// Flat list of all components (for search/autocomplete)
const DEFAULT_COMPONENTS = Object.values(COMPONENT_GROUPS).flat();

// ── Common Issues per Component ──────────────────────────────────
// User picks component first, then picks from these common issues.
// Reduces typing for foreign workers — just tap tap done.
const COMPONENT_ISSUES = {
  // Structural
  "Column":           ["Crack", "Spalling", "Exposed rebar", "Honeycombing", "Misaligned", "Bulging", "Deflection"],
  "Beam":             ["Crack", "Spalling", "Exposed rebar", "Sagging", "Honeycombing", "Deflection"],
  "Slab":             ["Crack", "Spalling", "Exposed rebar", "Uneven", "Honeycombing", "Deflection", "Hollow"],
  "Foundation":       ["Settlement", "Crack", "Heaving", "Water seepage", "Exposed rebar"],
  "Retaining Wall":   ["Crack", "Tilting", "Bulging", "Seepage", "Settlement", "Vegetation growth"],
  "Shear Wall":       ["Crack", "Spalling", "Exposed rebar", "Misaligned"],
  "Pile Cap":         ["Crack", "Exposed rebar", "Settlement", "Honeycombing"],

  // Architectural
  "Wall":             ["Crack", "Bulging", "Damp patch", "Uneven", "Hole", "Mould", "Peeling paint", "Stain", "Hollow sound"],
  "Door":             ["Misaligned", "Won't close", "Gap", "Scratch", "Broken hinge", "Defective lock", "Swollen", "Damaged frame"],
  "Window":           ["Won't open", "Seal gap", "Cracked glass", "Water ingress", "Faulty latch", "Scratch", "Fogging"],
  "Floor":            ["Scratch", "Uneven", "Hollow", "Stain", "Chipped", "Slope issue", "Cracked tile", "Ponding"],
  "Ceiling":          ["Sagging", "Water mark", "Crack", "Gap", "Mould", "Uneven", "Peeling paint", "Stain"],
  "Roof":             ["Leak", "Missing tile", "Ponding", "Crack", "Sagging", "Flashing defect", "Damaged membrane"],
  "Staircase":        ["Uneven step", "Crack", "Loose railing", "Chipped", "Slope issue", "Worn tread", "Gap"],
  "Railing":          ["Loose", "Rust", "Missing section", "Misaligned", "Broken post", "Sharp edge", "Wobbly"],
  "Balcony":          ["Crack", "Water ponding", "Loose railing", "Spalling", "Slope issue", "Waterproofing fail"],
  "Corridor":         ["Crack", "Uneven floor", "Chipped", "Stain", "Damaged skirting"],
  "Parapet":          ["Crack", "Tilting", "Spalling", "Water seepage", "Missing coping"],
  "Facade":           ["Crack", "Stain", "Bulging", "Loose panel", "Sealant failure", "Water ingress"],
  "Canopy":           ["Sagging", "Leak", "Rust", "Loose fixing", "Crack"],

  // M&E – Plumbing
  "Pipe":             ["Leak", "Burst", "Corroded", "Misaligned", "Blocked", "Noisy", "Loose bracket"],
  "Drain":            ["Blocked", "Slow drain", "Overflow", "Bad smell", "Crack", "Missing grate"],
  "Tap/Faucet":       ["Dripping", "Low pressure", "No hot water", "Loose", "Corroded", "Handle broken"],
  "Water Heater":     ["Not heating", "Leaking", "Noisy", "Error code", "Corroded"],
  "Toilet/WC":        ["Faulty flush", "Leaking base", "Crack", "Loose seat", "Blocked", "Running water"],
  "Basin/Sink":       ["Crack", "Loose", "Chipped", "Drain blocked", "Stain", "Silicone gap"],
  "Bathtub/Shower":   ["Leak", "Chipped", "Drain blocked", "Loose fitting", "Mould", "Low pressure"],
  "Floor Trap":       ["Blocked", "Bad smell", "Missing cover", "Crack", "Water backflow"],
  "Valve":            ["Leaking", "Stuck", "Corroded", "Wrong type", "Missing label"],

  // M&E – Electrical
  "Wiring":           ["Exposed wire", "Loose connection", "Wrong colour", "Not terminated", "Damaged insulation"],
  "Socket/Outlet":    ["No power", "Loose", "Cracked plate", "Wrong position", "Not earthed", "Sparking"],
  "Switch":           ["Not working", "Loose", "Cracked plate", "Wrong label", "Hot to touch"],
  "Light Fixture":    ["Not working", "Flickering", "Wrong colour temp", "Buzzing", "Loose", "Misaligned"],
  "Distribution Board": ["Tripped breaker", "Wrong label", "Missing cover", "Overheating", "Loose wiring"],
  "Cable Tray":       ["Misaligned", "Missing cover", "Overloaded", "Rust", "Loose support"],
  "Earth/Grounding":  ["Missing connection", "High resistance", "Corroded", "Wrong spec"],

  // M&E – ACMV
  "AC Unit":          ["Not cooling", "Leaking", "Noisy", "Bad smell", "Not working", "Ice forming"],
  "FCU":              ["Not cooling", "Leaking", "Noisy", "Vibrating", "Condensation"],
  "AHU":              ["Not working", "Noisy", "Vibrating", "Filter dirty", "Leak"],
  "Duct":             ["Leak", "Dented", "Loose joint", "Insulation damaged", "Noisy"],
  "Diffuser/Grille":  ["Misaligned", "Dirty", "Damaged", "Wrong size", "Condensation"],
  "Thermostat":       ["Not responding", "Wrong reading", "Display fault", "Loose mount"],
  "Condensate Pipe":  ["Leak", "Blocked", "Missing trap", "Wrong fall", "Not insulated"],
  "Chiller":          ["Not working", "Leak", "Noisy", "Error code", "Low performance"],

  // M&E – Fire
  "Sprinkler":        ["Damaged head", "Obstruction", "Corroded", "Wrong type", "Leaking", "Missing rosette"],
  "Fire Alarm":       ["Faulty", "No power", "False alarm", "Missing", "Damaged"],
  "Extinguisher":     ["Missing", "Expired", "Wrong type", "Damaged", "Obstructed"],
  "Hose Reel":        ["Leak", "Damaged nozzle", "Blocked", "Missing sign", "Obstructed access"],
  "Smoke Detector":   ["Not working", "Missing", "Wrong position", "Dirty", "Beeping"],
  "Emergency Light":  ["Not working", "Dim", "Wrong position", "Battery dead", "Damaged"],
  "Exit Sign":        ["Not lit", "Wrong direction", "Damaged", "Missing", "Obstructed"],

  // M&E – Lift
  "Lift Car":         ["Noise", "Vibration", "Misalignment", "Scratch", "Light fault"],
  "Lift Door":        ["Won't close", "Gap", "Noise", "Slow", "Misaligned"],
  "Lift Shaft":       ["Water seepage", "Crack", "Dirty", "Ventilation issue"],
  "Lift Motor":       ["Noise", "Vibration", "Overheating", "Oil leak"],
  "Lift Button/Panel": ["Not working", "Loose", "Wrong label", "Light fault"],

  // Finishes
  "Tile":             ["Cracked", "Loose", "Uneven grout", "Hollow", "Chipped", "Lippage", "Colour mismatch", "Stain"],
  "Paint":            ["Peeling", "Stain", "Uneven coat", "Crack line", "Bubbling", "Touch-up needed", "Colour mismatch", "Drip marks"],
  "Plaster":          ["Crack", "Uneven", "Hollow", "Bulging", "Debonding", "Rough finish"],
  "Waterproofing":    ["Seepage", "Damp wall", "Water mark", "Ponding", "Efflorescence", "Failed test", "Membrane torn"],
  "Skirting":         ["Gap", "Loose", "Misaligned", "Scratch", "Chipped", "Uneven joint"],
  "Cornice":          ["Gap", "Crack", "Misaligned", "Loose", "Uneven joint"],
  "Cove":             ["Gap", "Crack", "Uneven", "Loose", "Dirty"],
  "Wallpaper":        ["Peeling", "Bubble", "Tear", "Seam visible", "Stain", "Mould"],
  "Epoxy":            ["Peeling", "Bubble", "Uneven", "Crack", "Stain", "Discolouration"],
  "Screed":           ["Crack", "Uneven", "Hollow", "Dusty surface", "Wrong thickness"],

  // Carpentry
  "Cabinet":          ["Misaligned", "Scratch", "Broken hinge", "Swollen", "Chipped", "Door won't close", "Drawer stuck"],
  "Wardrobe":         ["Misaligned door", "Broken track", "Scratch", "Swollen", "Handle defect"],
  "Countertop":       ["Crack", "Chip", "Stain", "Uneven joint", "Scratch", "Edge damage"],
  "Shelf":            ["Sagging", "Loose bracket", "Scratch", "Misaligned", "Uneven"],
  "Vanity":           ["Scratch", "Swollen", "Loose hinge", "Chipped", "Water damage"],
  "Door Frame":       ["Gap", "Misaligned", "Scratch", "Swollen", "Crack"],
  "Window Frame":     ["Gap", "Misaligned", "Scratch", "Corroded", "Sealant fail"],
  "Timber Deck":      ["Warped", "Rot", "Loose board", "Splinter", "Stain", "Gap"],

  // Sanitary
  "Toilet Bowl":      ["Crack", "Loose", "Faulty flush", "Stain", "Chipped"],
  "Urinal":           ["Crack", "Blocked", "Faulty flush", "Stain", "Loose"],
  "Basin":            ["Crack", "Chipped", "Loose", "Drain blocked", "Stain"],
  "Bidet":            ["Leak", "Low pressure", "Not working", "Loose", "Crack"],
  "Mirror":           ["Crack", "Loose", "Stain", "Misaligned", "Foggy"],
  "Toilet Accessories": ["Loose", "Missing", "Broken", "Rust", "Wrong position"],
  "Towel Rail":       ["Loose", "Rust", "Misaligned", "Broken", "Wrong position"],

  // External/Landscape
  "External Wall":    ["Crack", "Stain", "Efflorescence", "Spalling", "Water seepage", "Mould"],
  "Driveway":         ["Crack", "Uneven", "Ponding", "Pothole", "Stain", "Settlement"],
  "Walkway":          ["Crack", "Uneven", "Trip hazard", "Ponding", "Chipped", "Loose paver"],
  "Drain/Gutter":     ["Blocked", "Crack", "Misaligned", "Overflow", "Missing grate"],
  "Garden/Planting":  ["Dead plant", "Overgrown", "Soil erosion", "Irrigation fault", "Pest damage"],
  "Fence/Gate":       ["Loose", "Rust", "Missing section", "Won't close", "Damaged lock", "Misaligned"],
  "Car Park":         ["Crack", "Ponding", "Faded marking", "Pothole", "Damaged barrier"],
  "Swimming Pool":    ["Leak", "Cracked tile", "Faulty pump", "Discolouration", "Uneven deck"],
  "Playground":       ["Damaged equipment", "Loose bolt", "Rust", "Worn surface", "Sharp edge"],

  // General
  "General":          ["Damage", "Missing item", "Wrong spec", "Incomplete work", "Safety hazard", "Housekeeping", "Other"],
  "Other":            ["Damage", "Missing item", "Wrong spec", "Incomplete work", "Safety hazard", "Housekeeping", "Other"],
};

// Auto-assign trade based on component group
const COMPONENT_TRADE = {};
(()=>{
  const tradeMap = {
    "Structural": "Structural Engineer",
    "Architectural": "General Contractor",
    "M&E – Plumbing": "Plumber",
    "M&E – Electrical": "Electrician",
    "M&E – ACMV": "ACMV Contractor",
    "M&E – Fire": "Fire Safety Contractor",
    "M&E – Lift": "Lift Contractor",
    "Finishes": "Finishes Contractor",
    "Carpentry": "Carpenter",
    "Sanitary": "Plumber",
    "External/Landscape": "Landscape Contractor",
    "General": "TBD",
  };
  for (const [group, components] of Object.entries(COMPONENT_GROUPS)) {
    const trade = tradeMap[group] || "TBD";
    for (const comp of components) {
      if (!COMPONENT_TRADE[comp]) COMPONENT_TRADE[comp] = trade;
    }
  }
  // Override specific components
  Object.assign(COMPONENT_TRADE, {
    "Door": "Carpenter", "Window": "Carpenter", "Floor": "Flooring Contractor",
    "Ceiling": "Ceiling Contractor", "Roof": "Roofing Contractor",
    "Tile": "Tiler", "Paint": "Painter", "Plaster": "Plasterer",
    "Waterproofing": "Waterproofing Contractor",
  });
})();

// ── Default Location Hierarchy ───────────────────────────────────
const DEFAULT_LEVELS = [
  "Basement 2", "Basement 1", "Ground Floor",
  "1st Floor", "2nd Floor", "3rd Floor", "4th Floor", "5th Floor",
  "6th Floor", "7th Floor", "8th Floor", "9th Floor", "10th Floor",
  "Roof", "Attic", "External", "Common Area"
];

const DEFAULT_ZONES = [
  "Zone A", "Zone B", "Zone C", "Zone D",
  "North Wing", "South Wing", "East Wing", "West Wing",
  "Block A", "Block B", "Block C",
  "Tower 1", "Tower 2", "Tower 3"
];

const DEFAULT_SUBZONES = [
  "Kitchen", "Bathroom", "Master Bedroom", "Bedroom 2", "Bedroom 3",
  "Living Room", "Dining Room", "Balcony", "Toilet", "Store Room",
  "Corridor", "Staircase", "Lobby", "Car Park", "Yard",
  "Entrance", "Hallway", "Utility Room", "Laundry", "Pantry",
  "Meeting Room", "Office", "Reception"
];

// ── Cost Impact ──────────────────────────────────────────────────
const COST_IMPACT_OPTIONS = [
  "No change",
  "To be confirmed by QS",
  "Variation Order (VO)",
  "Back charge to Contractor",
  "Back charge to Sub-Con",
  "Client to bear",
  "Shared cost",
  "Insurance claim",
  "Warranty claim",
  "Other",
];

const COST_RESPONSIBLE_OPTIONS = [
  "Main Contractor",
  "Sub-Contractor",
  "Client / Owner",
  "Architect",
  "Engineer",
  "Developer",
  "Shared",
  "TBD",
  "Other",
];

// ── Time / Duration ──────────────────────────────────────────────
const DURATION_OPTIONS = [
  "Same day",
  "1 day",
  "2 days",
  "3 days",
  "1 week",
  "2 weeks",
  "1 month",
  "2 months",
  "3 months",
  "TBD",
];

// ── Report Pack Defaults ─────────────────────────────────────────
const REPORT_SECTIONS = [
  { id: "summary", label: "Site Visit Summary", default: true },
  { id: "observations", label: "Observation List", default: true },
  { id: "photos", label: "Annotated Photo Appendix", default: true },
  { id: "outstanding", label: "Outstanding Items List", default: true },
];

// ── LocalStorage Keys ────────────────────────────────────────────
const COMPANY_KEY = "sdt-co-v1";
const TG_KEY = "sdt-tg-v2";
const EMAIL_KEY = "sdt-email-v1";
const GEMINI_KEY = "sdt-gemini-v1";
const PROJECT_KEY = "sdt-proj-v1";
const AI_LIMIT_KEY = "sdt-ai-usage";
const AI_DAILY_LIMIT = 50;
const ONBOARDING_KEY = "sdt-onboarded";
const STORAGE_KEY = "sdt-storage-v1";
const GDRIVE_KEY = "sdt-gdrive-v1";
const AI_PROVIDER_KEY = "sdt-ai-provider-v1";
const OLLAMA_KEY = "sdt-ollama-v1";
const OPENAI_KEY = "sdt-openai-v1";
