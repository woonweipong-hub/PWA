// SiteShrimp v2 — Shared Constants
// Entry types, statuses, severities, roles, components, location presets

// ── Entry Types ──────────────────────────────────────────────────
const ENTRY_TYPES = ["Observation", "Defect", "Update", "Instruction", "Pass"];
const ENTRY_TYPE_ICON = { Observation: "\u{1F441}", Defect: "\u26A0\uFE0F", Update: "\u{1F504}", Instruction: "\u{1F4CB}", Pass: "\u2705" };
const ENTRY_TYPE_COLOR = { Observation: "#34aadc", Defect: "#ff3b30", Update: "#ff9500", Instruction: "#5856d6", Pass: "#30d158" };
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
  // Infrastructure works
  "Roads": ["Asphalt Pavement", "Concrete Pavement", "Kerb", "Road Marking", "Road Sign", "Pothole", "Speed Hump", "Manhole Cover", "Catch Pit", "Shoulder", "Expansion Joint"],
  "Drainage": ["Box Drain", "Open Drain", "Slot Drain", "Sump Pit", "Gully", "Culvert", "Drainage Manhole", "Pipe Crossing", "Silt Trap", "Grating", "Headwall"],
  "Linkway": ["Linkway Roof", "Linkway Column", "Linkway Beam", "Linkway Paving", "Handrail", "Drip Line", "Fascia Board", "Gutter", "Downpipe", "Lighting"],
  // Construction site condition & safety
  "Site & Safety": ["Hoarding", "Scaffold", "Temporary Access", "Formwork", "Rebar", "Signage", "Storage Area", "PPE", "Housekeeping", "Spill", "Edge Protection", "Ladder"],
  // Facilities management
  "FM – Building Services": ["HVAC System", "Chiller", "Cooling Tower", "AHU", "FCU", "BMS Panel", "Generator", "Transformer", "Switchboard", "UPS", "Water Tank", "Pump Room"],
  "FM – Common Areas": ["Lobby", "Corridor", "Staircase", "Lift Lobby", "Car Park", "Loading Bay", "Bin Centre", "Guard House", "Mailroom", "Roof Access"],
  "FM – Amenities": ["Swimming Pool", "Gym", "Function Room", "BBQ Area", "Playground", "Tennis Court", "Landscape Area", "Water Feature"],
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

  // Roads
  "Asphalt Pavement": ["Crack", "Pothole", "Rutting", "Ravelling", "Bleeding", "Depression", "Settlement", "Edge break"],
  "Concrete Pavement":["Crack", "Spalling", "Joint failure", "Popout", "Scaling", "Settlement", "Faulting"],
  "Kerb":             ["Crack", "Misaligned", "Spalling", "Broken section", "Height issue", "Stain"],
  "Road Marking":     ["Faded", "Missing", "Incorrect", "Peeling", "Misaligned"],
  "Road Sign":        ["Missing", "Faded", "Damaged", "Loose post", "Wrong position", "Obstructed"],
  "Pothole":          ["Needs patching", "Water ponding", "Hazard", "Recurring"],
  "Speed Hump":       ["Worn", "Faded marking", "Crack", "Misaligned", "Wrong height"],
  "Manhole Cover":    ["Sunken", "Broken", "Missing", "Noisy", "Rust", "Wrong level"],
  "Catch Pit":        ["Silted", "Blocked", "Crack", "Missing grate", "Damaged"],
  "Shoulder":         ["Erosion", "Settlement", "Vegetation", "Crack", "Edge drop"],
  "Expansion Joint":  ["Damaged sealant", "Debris", "Water ingress", "Noisy", "Uneven"],
  // Drainage
  "Box Drain":        ["Blocked", "Silted", "Crack", "Broken cover", "Overflow", "Bad smell", "Collapsed"],
  "Open Drain":       ["Blocked", "Silted", "Overflow", "Vegetation", "Crack", "Erosion"],
  "Slot Drain":       ["Blocked", "Damaged slot", "Missing cover", "Uneven"],
  "Sump Pit":         ["Silted", "Blocked", "Pump fault", "Overflow", "Crack"],
  "Gully":            ["Silted", "Blocked", "Broken grate", "Sunken", "Bad smell"],
  "Culvert":          ["Silted", "Crack", "Headwall damage", "Scour", "Collapsed"],
  "Drainage Manhole": ["Silted", "Blocked", "Broken cover", "Bad smell", "Step iron loose"],
  "Pipe Crossing":    ["Exposed", "Damaged", "Leaking", "Misaligned"],
  "Silt Trap":        ["Full of silt", "Damaged", "Not maintained", "Overflow"],
  "Grating":          ["Missing", "Broken", "Rusted", "Wrong size", "Noisy"],
  "Headwall":         ["Crack", "Scour", "Settlement", "Vegetation", "Damaged apron"],
  // Linkway
  "Linkway Roof":     ["Leak", "Sagging", "Rust", "Damaged sheet", "Fixing loose", "Stain"],
  "Linkway Column":   ["Crack", "Spalling", "Rust", "Misaligned", "Paint defect"],
  "Linkway Beam":     ["Crack", "Spalling", "Rust", "Sagging", "Paint defect"],
  "Linkway Paving":   ["Uneven", "Trip hazard", "Crack", "Loose paver", "Ponding", "Stain"],
  "Handrail":         ["Loose", "Rust", "Broken", "Missing section", "Sharp edge"],
  "Drip Line":        ["Clogged", "Crack", "Missing", "Stain trail"],
  "Fascia Board":     ["Loose", "Stain", "Damaged", "Colour mismatch", "Paint defect"],
  "Gutter":           ["Blocked", "Leak", "Sagging", "Misaligned", "Rust"],
  "Downpipe":         ["Blocked", "Leak", "Loose bracket", "Rust", "Broken"],
  "Lighting":         ["Not working", "Broken lens", "Missing", "Wrong position", "Flickering"],
  // Site & Safety
  "Hoarding":         ["Damaged", "Missing section", "Signage missing", "Graffiti", "Leaning"],
  "Scaffold":         ["Loose tie", "Missing plank", "No toe board", "Incomplete tag", "Overloaded", "No guardrail"],
  "Temporary Access": ["Blocked", "Unsafe", "No signage", "Slippery", "Uneven"],
  "Formwork":         ["Misaligned", "Loose tie", "Not clean", "Damaged panel", "Leaking"],
  "Rebar":            ["Wrong spacing", "Missing tie", "Rust", "Wrong size", "Not as drawing"],
  "Signage":          ["Missing", "Faded", "Damaged", "Wrong position", "Obstructed"],
  "Storage Area":     ["Disorganised", "Unsafe stacking", "No labelling", "Blocking access", "Fire risk"],
  "PPE":              ["Not worn", "Missing", "Damaged", "Wrong type"],
  "Housekeeping":     ["Debris", "Spill", "Dust", "Blocked walkway", "No bins"],
  "Spill":            ["Oil", "Chemical", "Water", "Concrete", "Paint"],
  "Edge Protection":  ["Missing", "Loose", "Damaged", "Wrong height", "Gap"],
  "Ladder":           ["Damaged", "Not secured", "Wrong height", "Slippery step", "Missing foot"],
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
    "Roads": "Road Contractor",
    "Drainage": "Civil/Drainage Contractor",
    "Linkway": "General Contractor",
    "Site & Safety": "Safety Officer",
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

// ── Work Categories ──────────────────────────────────────────────
// Top-level category a user picks before logging. Each category narrows
// the COMPONENT dropdown to only the relevant groups so users are not
// overwhelmed by unrelated items.
const WORK_CATEGORIES = {
  "Building Defects (Landed)": {
    icon: "\u{1F3E0}", // 🏠
    desc: "Houses, bungalows, terrace, cluster",
    groups: ["Structural","Architectural","M&E – Plumbing","M&E – Electrical","M&E – ACMV","Finishes","Carpentry","Sanitary","External/Landscape","General"],
  },
  "Building Defects (Highrise)": {
    icon: "\u{1F3E2}", // 🏢
    desc: "Condo, apartment, tower, mixed-use",
    groups: ["Structural","Architectural","M&E – Plumbing","M&E – Electrical","M&E – ACMV","M&E – Fire","M&E – Lift","Finishes","Carpentry","Sanitary","External/Landscape","General"],
  },
  "Construction Site": {
    icon: "\u{1F3D7}\uFE0F", // 🏗️
    desc: "Active construction, workmanship, site condition",
    groups: ["Structural","Architectural","M&E – Plumbing","M&E – Electrical","M&E – ACMV","M&E – Fire","Finishes","Carpentry","Site & Safety","General"],
  },
  "Interior Works": {
    icon: "\u{1F6CB}\uFE0F", // 🛋️
    desc: "Fit-out, renovation, ID works",
    groups: ["Architectural","Finishes","Carpentry","Sanitary","M&E – Electrical","M&E – Plumbing","M&E – ACMV","General"],
  },
  "Facilities Management": {
    icon: "\u{1F3E0}", // 🏠
    desc: "FM defects, building services, common areas",
    groups: ["Architectural","M&E – Plumbing","M&E – Electrical","M&E – ACMV","M&E – Fire","M&E – Lift","Finishes","Sanitary","FM – Building Services","FM – Common Areas","FM – Amenities","External/Landscape","General"],
  },
  "Infrastructure Works": {
    icon: "\u{1F6E3}\uFE0F", // 🛣️
    desc: "Roads, drainage, linkway, external works",
    groups: ["Roads","Drainage","Linkway","External/Landscape","Structural","General"],
  },
  "CONQUAS": {
    icon: "\u{1F3DB}️",
    desc: "CONQUAS-scored handover — Internal Finishes assessment",
    groups: ["Architectural","Finishes","Carpentry","Sanitary","M&E – Plumbing","M&E – Electrical","M&E – ACMV","General"],
  },
  "Handover Walkthrough": {
    icon: "\u{1F511}", // 🔑
    desc: "Pre-handover snag list — finishes, sanitary, fixtures, doors/windows, electrical points",
    groups: ["Architectural","Finishes","Carpentry","Sanitary","M&E – Electrical","M&E – Plumbing","M&E – ACMV","General"],
  },
  "Test & Commission (T&C)": {
    icon: "\u{2699}️", // ⚙️
    desc: "Water-tightness, plumbing pressure, electrical, ACMV balancing, lift commissioning",
    groups: ["M&E – Plumbing","M&E – Electrical","M&E – ACMV","M&E – Fire","M&E – Lift","Sanitary","Structural","General"],
  },
  "M&E Inspection": {
    icon: "\u{26A1}", // ⚡
    desc: "Mechanical, electrical, plumbing, ACMV, fire — services-focused inspection",
    groups: ["M&E – Plumbing","M&E – Electrical","M&E – ACMV","M&E – Fire","M&E – Lift","General"],
  },
  // BCA Temporary Occupation Permit (TOP) readiness inspection. Variant
  // schema lives at schema/entries/top/v1.json; AI prompt addendum sits in
  // AI_VARIANT_TABLE in deploy/pocketbase/pb_hooks/main.pb.js. Sources:
  // BCA BPTOP industry sharing 2026 items 1-5; CSCTOP Form Companion
  // v1.0 29 Apr 2026; Approved Document Ver 7.08 effective 1 Oct 2025.
  // Component groups span the full BCA TOP scope — accessibility (COA),
  // structural (AD §B), staircase (AD §E), barriers (AD §H), lifts
  // (AD §K + BC FI Regs 2025), LPS (AD §L), env. sustainability (ES Code
  // 4th ed.), storey shelter (TRSS).
  "TOP Inspection": {
    icon: "\u{1F3DB}️", // 🏛
    desc: "BCA Temporary Occupation Permit readiness — verbatim NC categories with Approved Document / COA / TRSS clause references",
    groups: ["Architectural","Structural","Finishes","M&E – Plumbing","M&E – Electrical","M&E – ACMV","M&E – Fire","M&E – Lift","Sanitary","External/Landscape","Site & Safety","General"],
  },
  // BCA Buildable Design Score (B-Score) — COP 2022. Tag entries that
  // relate to buildability concerns (PPVC / MET / prefab / DfMA usage,
  // wet-trade vs precast trade-off, labour-saving system choice). This
  // is a labelling category for now; a separate B-Score calculator
  // (per the COP 2022 matrix) is planned at the project level. The
  // BCA-verbatim term for the activity is "buildability assessment".
  "Buildability Assessment": {
    icon: "\u{1F9F1}", // 🧱
    desc: "BCA Buildable Design Score (B-Score) — buildability / constructability observations on structural, wall, archi, M&E systems",
    groups: ["Structural","Architectural","Finishes","M&E – Plumbing","M&E – Electrical","M&E – ACMV","General"],
  },
  // BCA Quality Mark for Good Workmanship — Guide on Quality Mark
  // Scheme (Rev 22 May 2025). Internal-finish quality assessment of
  // private residential dwellings. Threshold 85 (tender from 1 Jun
  // 2020) / 80 (before). Tiered Rating: Star 92+, Excellent 90 to <92,
  // Merit 85 to <90 — gated additionally on waterponding pass-rate and
  // window watertightness pass-rate. Component groups span the seven
  // QM Architectural Items: Floor, Internal Wall, Ceiling, Door,
  // Window, Component, M&E Fittings.
  "Quality Mark Assessment": {
    icon: "\u{2705}", // ✅
    desc: "BCA Quality Mark — internal-finish quality assessment of private residential per Guide on QM Scheme (22 May 2025)",
    groups: ["Architectural","Finishes","Carpentry","Sanitary","M&E – Plumbing","M&E – Electrical","M&E – ACMV","General"],
  },
  "Others": {
    icon: "\u{1F4CB}", // 📋
    desc: "Custom — all components available, free-text allowed",
    groups: Object.keys(COMPONENT_GROUPS),
    userDefined: true,
  },
};
const WORK_CATEGORY_KEY = "sdt-work-category-v1";

// ── BCA TOP Inspection checklist ─────────────────────────────────
// Verbatim BCA Temporary Occupation Permit NC categories + checklist
// items, transcribed from the user's `top_checklist_package.md` JSONL
// package (BCA-aligned) plus gaps identified from the BCA BPTOP 2026
// industry sharing decks (items 1, 2, 3) and the CSCTOP Form Companion
// v1.0 (29 Apr 2026). Used by the TopCheckWizard component to drive a
// pre-TOP self-audit. Each item carries a verbatim Approved Document /
// COA / TRSS / ES Code clause reference for QP traceability.
//
// Schema:
//   id          — stable item identifier (e.g. "STA-002")
//   category    — top-level NC grouping (matches the top_nc_category
//                 enum in schema/entries/top/v1.json)
//   title       — short label shown in the wizard
//   requirement — verbatim or near-verbatim BCA rule text
//   clauseRef   — verbatim BCA clause notation (AD §C cl. C.3.2.1 etc.)
//   threshold   — numeric or descriptive threshold (mm, m, ratio, etc.)
//   gate        — true if NC blocks TOP (must rectify before inspection);
//                 false for advisory NCs that won't fail TOP
//   severity    — default severity if the user marks fail
//                 (Critical | Major | Minor | Observation)
//   guidance    — short hint shown to the field user
//
// When the wizard records a fail, a defect is auto-created with the
// TOP variant fields populated from this row (top_nc_category =
// item.category, top_clause_ref = item.clauseRef, top_readiness_gate =
// item.gate, severity = item.severity, etc.).
const TOP_CHECKLIST = [
  // 1. Documentation
  { id:"DOC-001", category:"Site Readiness", title:"Required TOP documents available", requirement:"All required forms, certificates, as-built plans, test reports and clearances applicable to the TOP scope shall be available and consistent with the built work.", clauseRef:"BCA TOP/CSC application requirements", threshold:"All required documents present", gate:true, severity:"Critical", guidance:"Show only applicable documents by project profile and phase." },
  { id:"DOC-002", category:"Site Readiness", title:"Built works consistent with approved / as-built plans", requirement:"The built layout, key dimensions and provided elements within the TOP scope shall be generally consistent with approved and as-built plans, without unauthorised deviations affecting compliance.", clauseRef:"BCA TOP/CSC technical clearance flow", threshold:"No unauthorised deviations from approved plan", gate:true, severity:"Critical", guidance:"Use this as a global plan-consistency gate before detailed checks." },

  // 2. Site Readiness
  { id:"SITE-001", category:"Site Readiness", title:"Site is in move-in condition", requirement:"The TOP scope shall be completed, clean, not occupied, with site office removed and materials/equipment cleared from occupied areas.", clauseRef:"BCA site-condition circular", threshold:"Site clear of construction materials and equipment", gate:true, severity:"Critical", guidance:"Capture panoramic photos for common areas and site frontage." },
  { id:"SITE-002", category:"Site Readiness", title:"Safe and proper access to and within development", requirement:"Safe and proper access shall be available to and within the development, free of unsafe obstructions, incomplete surfaces or dangerous temporary conditions.", clauseRef:"BCA site-condition circular", threshold:"All routes safe + clear", gate:true, severity:"Critical", guidance:"Apply to public approach, internal access routes and routes serving the TOP phase." },
  { id:"SITE-003", category:"Site Readiness", title:"TOP phase segregated from construction zones", requirement:"For phased TOP, occupied areas shall be robustly separated from active construction zones, with separate public and construction access where applicable.", clauseRef:"BCA site-condition circular", threshold:"Segregation in place if phased TOP", gate:true, severity:"Critical", guidance:"NA for non-phased TOP." },
  { id:"SITE-004", category:"Site Readiness", title:"Driveways, footpaths and drop-off complete", requirement:"Driveways, footpaths, drop-off points and circulation surfaces serving the TOP scope shall be completed and safe for use.", clauseRef:"BCA TOP/CSC site-condition expectations", threshold:"External works complete for TOP scope", gate:true, severity:"Major", guidance:"Include drop-off, public walkways, ramps and interfaces to entrances." },

  // 3. Headroom & Ceiling Height
  { id:"GEN-001", category:"Headroom & Ceiling Height", title:"Headroom along access routes complies", requirement:"Headroom along access routes and circulation spaces shall be measured from finished floor level to the underside of obstruction and meet the minimum acceptable solution.", clauseRef:"AD §C cl. C.3.2.1", threshold:"≥ 2000 mm", gate:true, severity:"Major", guidance:"Measure at the lowest obstruction point (beam, duct, fixture, openable window)." },
  { id:"GEN-002", category:"Headroom & Ceiling Height", title:"Ceiling height in rooms complies", requirement:"Ceiling height in rooms and spaces shall meet minimum requirements in the acceptable solution, subject to stated exemptions.", clauseRef:"AD §C cl. C.3.3", threshold:"per room profile", gate:false, severity:"Major", guidance:"Use room classification to evaluate threshold; permit NA where exempted spaces apply." },

  // 4. Staircases
  { id:"STA-001", category:"Staircase", title:"No projections into staircase space below 2.0 m", requirement:"No projection other than handrails is allowed into the staircase space within a height of 2.0 m from the landing or pitch line.", clauseRef:"AD §E cl. E.3.2.1", threshold:"No projection below 2000 mm", gate:true, severity:"Critical", guidance:"Capture photo and measurement where overhead projection is present." },
  { id:"STA-002", category:"Staircase", title:"Stair clear width complies", requirement:"Clear width of staircase shall meet the minimum required width measured in accordance with the approved method, accounting for handrail and balustrade projections.", clauseRef:"AD §E cl. E.3.3.1", threshold:"≥ 1000 mm (per stair profile)", gate:true, severity:"Critical", guidance:"Capture measurement at narrowest point with tape visible." },
  { id:"STA-003", category:"Staircase", title:"Risers and treads uniform within tolerance", requirement:"Riser heights and tread widths shall comply with the applicable acceptable solution and be consistent within the stair flight (≤5 mm tolerance between consecutive steps).", clauseRef:"AD §E cl. E.3.4.4", threshold:"Tolerance ≤ 5 mm between consecutive steps", gate:true, severity:"Critical", guidance:"Store separate measured fields for riser and tread; apply 225 / 250 / 275 mm tread rule by profile." },
  { id:"STA-004", category:"Staircase", title:"Landings comply", requirement:"Landing width and configuration shall comply with the acceptable solution, including minimum clearance and absence of steps/drops except where specifically permitted.", clauseRef:"AD §E cl. E.3.5", threshold:"≥ 1000 mm + no unauthorised step/drop", gate:true, severity:"Major", guidance:"Record whether step/drop exists at landing and whether allowed by dwelling-unit exception." },
  { id:"STA-005", category:"Staircase", title:"Handrails provided and compliant", requirement:"Handrails shall be provided to staircases with more than 5 steps and comply with height, continuity, gripping surface and clearance requirements.", clauseRef:"AD §E cl. E.3.6", threshold:"800–1000 mm height; continuous; both sides where required", gate:true, severity:"Critical", guidance:"Capture handrail height and continuity; note both sides where applicable." },
  { id:"STA-006", category:"Staircase", title:"Non-slip nosing strips with permanent contrasting colour", requirement:"All steps must be fitted with non-slip nosing strips between 50 mm and 65 mm in width with permanent contrasting colours. Tape is not an acceptable solution.", clauseRef:"COA 4.11.2", threshold:"50–65 mm permanent contrasting nosing; tape NOT acceptable", gate:true, severity:"Critical", guidance:"Verify nosing material is permanent (paint or moulded); reject tape applications." },

  // 5. Accessibility
  { id:"ACC-001", category:"Accessible Route Provision", title:"Continuous accessible route provided", requirement:"An accessible route shall be provided from designated arrival points to key facilities within the TOP scope, with required ramps, doors, lifts and surfaces completed.", clauseRef:"COA cl. 2.1.1", threshold:"Continuous route present", gate:true, severity:"Critical", guidance:"Apply along the full route rather than isolated spot checks." },
  { id:"ACC-002", category:"Accessible Route Width", title:"Accessible route width complies", requirement:"Width of accessible routes, corridors and paths shall meet the minimum required by Table 3 of the Code on Accessibility.", clauseRef:"COA cl. 4.2.1 (Table 3)", threshold:"1500 mm (residential / office / hotel) or 1800 mm (other)", gate:true, severity:"Major", guidance:"Reduce to 1200 mm clear ramp width acceptable only where alternative stepped approach is provided AND total rise ≤ 1200 mm." },
  { id:"ACC-003", category:"Accessible Washrooms / Doorways / Ramps", title:"Accessible washroom items complete", requirement:"Accessible washrooms shall include all required items: hooks, mirror, bidet spray, call bell, horizontal bar on door, with at least 300 mm space on push side of door.", clauseRef:"COA cl. 4.5.2, 5.2.1", threshold:"All items present + ≥ 300 mm push-side space", gate:true, severity:"Major", guidance:"Common omissions: hooks, mirror, bidet spray, call bell, horizontal bar on door." },
  { id:"ACC-004", category:"Accessible Washrooms / Doorways / Ramps", title:"Accessible doorway and route levelled, no large gaps", requirement:"Accessible route doorway must be levelled. Gratings and gaps along accessible route must be ≤ 12 mm. Coloured bands to be provided at vertical rises.", clauseRef:"COA cl. 4.1.1.1, 4.5.2", threshold:"Route levelled; gaps ≤ 12 mm", gate:true, severity:"Major", guidance:"Inspect drainage gratings, expansion joints, threshold drops along the accessible route." },

  // 6. Lighting
  { id:"LGT-001", category:"Other", title:"Natural lighting to rooms complies", requirement:"Rooms intended to be naturally lit shall have windows or openings sized and located to satisfy the acceptable solution for natural lighting.", clauseRef:"AD §F cl. F.3.2", threshold:"Per room profile + opening size", gate:false, severity:"Major", guidance:"Capture window/opening reference and any obstruction by unauthorised partitioning." },

  // 7. Ventilation
  { id:"VEN-001", category:"Mode of Ventilation", title:"Natural ventilation to rooms complies", requirement:"Windows and openings intended for natural ventilation shall open to the exterior, compliant airwells or recesses and meet the acceptable solution for ventilation. Natural ventilation cannot be provided to areas > 12 m from window/opening.", clauseRef:"AD §G cl. G.3.2.1, G.3.2.2, G.3.2.3", threshold:"≤ 12 m from window/opening", gate:false, severity:"Major", guidance:"Recirculating fans are NOT an acceptable solution. NV space with mechanical assistance + CFD reports per SS 553 may be considered as alternative." },
  { id:"VEN-002", category:"Mode of Ventilation", title:"Mechanically ventilated spaces completed where required", requirement:"Rooms or spaces relying on mechanical ventilation under the approved design shall have the required vents, grilles and systems installed. Fresh air vents must be provided to all air-conditioned areas.", clauseRef:"AD §G cl. G.2.4", threshold:"All required vents/grilles installed; fresh-air intake to AC areas", gate:false, severity:"Major", guidance:"Basic / Standard AC units do NOT cater for fresh-air intake — verify dedicated fresh-air provision." },

  // 8. Safety from Falling
  { id:"BAR-001", category:"Safety from Falling — barriers", title:"Safety barriers present at all required drops", requirement:"Safety barriers or parapets shall be installed at all locations with fall risk requiring protection within the TOP scope.", clauseRef:"AD §H cl. H.2, H.3", threshold:"Barrier present at every required edge", gate:true, severity:"Critical", guidance:"First gate before detailed barrier measurements." },
  { id:"BAR-002", category:"Safety from Falling — barriers", title:"Barrier height complies", requirement:"Barrier height shall meet or exceed the minimum required height, including higher measurement basis where climbable toeholds are present.", clauseRef:"AD §H cl. H.3.2.1, H.3.4A.1", threshold:"≥ 1000 mm; ≥ 850 mm from last climbable toehold", gate:true, severity:"Critical", guidance:"Record whether measurement is from floor level or last climbable toehold (foothold = ≥ 150 × 150 mm AND < 45° gradient)." },
  { id:"BAR-003", category:"Safety from Falling — gaps", title:"Barrier base gap complies", requirement:"There shall be no gap at the lowest part of a barrier larger than permitted within the lowest 75 mm zone.", clauseRef:"AD §H cl. H.3.4.1", threshold:"≤ 75 mm at lowest part", gate:true, severity:"Critical", guidance:"Measure from finished floor to underside / lowest gap at barrier base." },
  { id:"BAR-004", category:"Safety from Falling — gaps", title:"Barrier openings comply", requirement:"The size of any opening or gap in a barrier shall not permit the passage of a sphere larger than allowed for the relevant building type.", clauseRef:"AD §H cl. H.3.4.3a", threshold:"≤ 100 mm sphere (non-industrial); ≤ 150 mm (industrial); ≤ 500 mm (maintenance only)", gate:true, severity:"Critical", guidance:"Store building classification and area type before evaluating the result." },
  { id:"BAR-005", category:"Safety from Falling — barriers", title:"Barrier not easily climbable", requirement:"Barrier shall not include climbable toeholds within the prohibited vertical zone and shall satisfy the climbability provisions where applicable.", clauseRef:"AD §H cl. H.3.4A", threshold:"No climbable toeholds in prohibited zone", gate:true, severity:"Major", guidance:"Record presence of perforations, kerbs or protrusions that function as toeholds." },
  { id:"BAR-006", category:"Glass safety barrier", title:"Glass barriers use compliant glass", requirement:"Where glass is used as part or whole of a barrier, the glass type and installation shall comply with the acceptable solution for glass barriers.", clauseRef:"AD §H cl. H.3.5", threshold:"Compliant glass type + installation", gate:false, severity:"Major", guidance:"Record glass barrier presence and supporting listing/details where applicable." },

  // 9. Facade
  { id:"FCD-001", category:"Site Readiness", title:"No incomplete facade affecting TOP scope", requirement:"Facade elements near areas intended for occupation or public use shall be complete and safe, with no loose or partially installed elements that present risk.", clauseRef:"BCA TOP/CSC site-condition expectations", threshold:"Facade complete + safe in TOP scope", gate:true, severity:"Critical", guidance:"Focus on falling-object risk and visibly incomplete envelope works." },

  // 10. Units & Common Facilities
  { id:"UNT-001", category:"Site Readiness", title:"Units within TOP scope complete for occupancy", requirement:"Units included in the TOP scope shall have basic finishing works and fittings completed such that compliance-relevant measurements and safe occupation are possible.", clauseRef:"BCA TOP/CSC site-condition expectations", threshold:"Units complete in TOP scope", gate:true, severity:"Critical", guidance:"Apply to residential or occupiable units within the TOP phase." },
  { id:"COM-001", category:"Site Readiness", title:"Common facilities in TOP scope complete or isolated", requirement:"Common facilities (roofs, sky terraces, pool decks, courts) shall either be complete and safe or securely isolated from occupants.", clauseRef:"BCA TOP/CSC site-condition expectations", threshold:"Complete OR isolated", gate:true, severity:"Critical", guidance:"Mark NA for facilities outside the TOP phase and verify segregation if excluded." },

  // 11. Lifts & Fixed Installations
  { id:"LFT-001", category:"Fixed Installations (Lifts / Escalators / MCPS)", title:"Required lift provision available for TOP scope", requirement:"Required lifts serving the TOP scope shall be installed and accessible per the approved design and acceptable solution where applicable.", clauseRef:"AD §K cl. K.2.1, K.3 + BC (FI) Regs 2025 (SS 550:2020 / EN 81-41:2024)", threshold:"Lift present + accessible + per FI plan", gate:true, severity:"Critical", guidance:"Focus on presence, access and document consistency rather than specialist lift testing." },
  { id:"FI-001", category:"Fixed Installations (Lifts / Escalators / MCPS)", title:"Sheltered passageway to motor room", requirement:"Lift motor room shall be provided with a sheltered passageway of at least 1.0 m clear width and 2.0 m clear height.", clauseRef:"BC (FI) Regs 2025 — Approved Document for Fixed Installations", threshold:"≥ 1.0 m × 2.0 m clear", gate:true, severity:"Major", guidance:"Capture passageway with tape visible at narrowest / lowest point." },
  { id:"FI-002", category:"Fixed Installations (Lifts / Escalators / MCPS)", title:"Lift refuge spaces in headroom + lift pit", requirement:"Lift shaft shall provide minimum 2 refuge spaces (same type) in headroom AND lift pit, complying with Type 1 (upright 0.4×0.5×2.0 m) / Type 2 (crouching 0.5×0.7×1.0 m) / Type 3 (laying 0.7×1.0×0.5 m).", clauseRef:"BC (FI) Regs 2025 — Approved Document Table 3", threshold:"2 refuge spaces of same type per location", gate:true, severity:"Critical", guidance:"Photograph car-top + lift-pit refuge labels with measurements." },

  // 12. Lightning Protection
  { id:"LPS-001", category:"Lightning Protection System", title:"LPS complete and per SS 555", requirement:"Lightning protection system shall be present and generally consistent with the approved design and SS 555 (Class III minimum), with supporting certificate where required.", clauseRef:"AD §L cl. 3.1 + SS 555 Parts 1, 2, 3", threshold:"Class III minimum; LPS tape ≤ 100 mm from parapet edge; complete", gate:true, severity:"Critical", guidance:"Capture down conductors / air terminals; check tape distance from parapet, corner protection, bi-metallic connectors. Reject copper tape embedded in concrete only when contrary to design." },
  { id:"LPS-002", category:"Lightning Protection System", title:"LPS warning sign at habitable / non-habitable entrances", requirement:"LPS warning sign provided at entrances to habitable & non-habitable spaces.", clauseRef:"AD §L cl. 3.1 + SS 555", threshold:"Warning sign at every required entrance", gate:false, severity:"Minor", guidance:"Capture sign location relative to entrance." },

  // 13. Storey Shelter
  { id:"TRSS-001", category:"Storey Shelter (S/C SS)", title:"No openings in S/C SS compartment except 2 vent sleeves + MV", requirement:"No other openings shall be permitted in each S/C SS compartment except for the two ventilation sleeves (in closed position) and the required MV opening.", clauseRef:"TRSS cl. 2.12.1(e)", threshold:"Only 2 vent sleeves + 1 MV opening", gate:true, severity:"Critical", guidance:"MV must be located OUTSIDE SS wall (not within). Capture compartment plan/elevation." },
  { id:"TRSS-002", category:"Storey Shelter (S/C SS)", title:"Fire door at SS entrance opens correctly per level", requirement:"At fire discharge level, fire door at SS entrance must open AWAY from staircase (in direction of exit travel). At typical level, fire door can open INTO staircase.", clauseRef:"TRSS cl. 2.12.2", threshold:"Discharge level: door opens away from staircase", gate:true, severity:"Critical", guidance:"Document the door swing direction at the fire discharge level — relocating later requires abortive works." },

  // 14. Environmental Sustainability
  { id:"ENV-001", category:"Env. Sustainability — NRB02 (door / vestibule)", title:"Self-closing / automated doors at exterior; vestibules at high-traffic doorways", requirement:"Building entrances and door openings to building exterior or non-air-conditioned spaces shall be equipped with automated technology or self-closing devices, AND vestibules for high-traffic doorways (e.g. main entrances, doorways to transport nodes / commercial buildings).", clauseRef:"ES Code 4th ed. NRB02-2 (a)+(b)", threshold:"Self-closing/automated + vestibule (or air-curtain ≥ 2.0 m/s per ANSI/AMCA 220)", gate:false, severity:"Major", guidance:"Roller shutters left open during AC operation = common finding. Acceptable solution: notification system (audible alarm / warning light)." },
  { id:"ENV-002", category:"Env. Sustainability — NRB06 (chiller / pump / cooling tower / AHU)", title:"Chiller clearance ≥ 1.5 m above for maintenance", requirement:"Clearance of 1.5 m or more above the chiller shall be provided to facilitate maintenance, overhaul or replacement.", clauseRef:"ES Code 4th ed. NRB06-1", threshold:"≥ 1.5 m above chiller", gate:false, severity:"Major", guidance:"Capture height with tape visible from chiller top to ceiling / overhead obstruction." },
  { id:"ENV-003", category:"Env. Sustainability — NRB06 (chiller / pump / cooling tower / AHU)", title:"AHU > 35 kW floor-mounted per SS 553", requirement:"Air handling units (AHUs) of cooling capacity greater than 35 kW shall be floor mounted as stipulated in SS 553. AHUs deemed floor-mounted if on platform with clear path accessible by lift or staircase.", clauseRef:"ES Code 4th ed. NRB06-4(a) + SS 553", threshold:"AHU > 35 kW: floor mount OR maintenance platform with lifting points", gate:false, severity:"Major", guidance:"Acceptable: AHU maintenance platform installed; lifting points (chain blocks) for transport of AHU fan/motor." },
  { id:"ENV-004", category:"Env. Sustainability — NRB06 (chiller / pump / cooling tower / AHU)", title:"Pump and cooling tower maintenance clearances", requirement:"Pump systems: minimum 0.6 m perimeter clearance + 1 m overhead. Cooling towers: 600 mm wide platforms with handrails + 2 m clearance from cooling tower top to trellis.", clauseRef:"ES Code 4th ed. NRB06-2 + NRB06-3", threshold:"Pump: 0.6 m perimeter + 1 m overhead. Cooling tower: 600 mm platform + 2 m to trellis", gate:false, severity:"Major", guidance:"Capture maintenance access points with tape visible." },

  // 15. Windows & Vehicular
  { id:"WND-001", category:"Other", title:"Windows comply with safety provisions", requirement:"Windows and associated fixings shall be installed consistently with the approved design and safety provisions for windows.", clauseRef:"AD §M cl. M.2, M.3", threshold:"Per approved design + safety provision", gate:false, severity:"Major", guidance:"Use for visible compliance and installation completeness rather than laboratory proof." },
  { id:"VEH-001", category:"Other", title:"Vehicular barriers provided where required", requirement:"Vehicular barriers shall be provided and generally complete where there is risk of vehicles impacting edges or drops in buildings.", clauseRef:"AD §O cl. O.2, O.3", threshold:"Barrier present at every required vehicular edge", gate:false, severity:"Major", guidance:"Apply to ramps, podium edges and carparks where vehicular impact risk exists." },

  // 16. Post-Inspection Admin
  { id:"ADM-001", category:"Other", title:"Written advice items tracked to closure", requirement:"Any written advice, comments or follow-up items arising from inspection shall be clearly tracked, assigned and closed before final acceptance of TOP readiness.", clauseRef:"BCA TOP/CSC re-inspection process", threshold:"All open items closed if applicable", gate:true, severity:"Major", guidance:"Useful for re-inspection and close-out workflows." },
];

// Top-level NC categories for TOP wizard grouping. Order matches the
// suggested walk-through sequence (site-readiness gate first, then
// architectural / accessibility / safety, then services, then admin).
const TOP_CATEGORIES = [
  "Site Readiness",
  "Headroom & Ceiling Height",
  "Staircase",
  "Accessible Route Provision",
  "Accessible Route Width",
  "Accessible Washrooms / Doorways / Ramps",
  "Mode of Ventilation",
  "Safety from Falling — barriers",
  "Safety from Falling — gaps",
  "Glass safety barrier",
  "Lightning Protection System",
  "Storey Shelter (S/C SS)",
  "Env. Sustainability — NRB02 (door / vestibule)",
  "Env. Sustainability — NRB06 (chiller / pump / cooling tower / AHU)",
  "Fixed Installations (Lifts / Escalators / MCPS)",
  "Other",
];

// Storage key for in-progress TOP wizard state (per project).
const TOP_WIZARD_KEY = "sdt-top-wizard-v1";

// ── Photo-entry export base column order ────────────────────────
// Single source of truth for the Entries-sheet headers in the photo
// ZIP export. The drift guard at tools/schema-check.js asserts every
// header here has a matching 'x-csv-header' property in
// schema/entries/v1.json. Adding a column here without updating the
// schema (or vice versa) fails the build. Variant columns (CONQUAS
// Assessment Zone, etc.) are appended to this base at export time
// using the manifest's extra_columns list.
const ENTRY_BASE_HEADERS = [
  "Filename","ISO 19650 Filename","CONQUAS Element","Folder","Entry ID",
  "Entry Type","Title","Description","Severity","Status",
  "Component","Issue","Location","Assignee","Trade",
  "Logged By","Role","Date","Due Date","Source Filename",
  // v1.1.0 additive — geo, drawing pin, media integrity, AI provenance.
  "GPS Lat","GPS Lng","Drawing ID","Drawing Page","Pin X","Pin Y",
  "Media Hash","Created At",
  "AI Confidence","AI Model","AI Prompt Version","Human Reviewed","Field Provenance",
];

// ── CONQUAS Internal-Finishes (IF) elements — canonical order ───
// Verbatim from BCA CONQUAS (Private Residential) R1, Appendix 1.
// These SEVEN names carry contractual weight — do NOT paraphrase
// ("M&E" alone is wrong; must be "M&E Fittings"). Used for REVIEW
// grouping and CONQUAS ZIP export. "Other" catches non-IF components
// (structural, external, infra, safety) so nothing is silently dropped.
const CONQUAS_IF_ELEMENTS = [
  "Floor", "Wall", "Ceiling", "Door", "Window", "Component", "M&E Fittings",
];
const CONQUAS_ELEMENT_OTHER = "Other";

// Versioned contract for the conquasElementOf() mapping rules below.
// Bump when the mapping logic changes (added/removed bucket, renamed
// element, reassigned component). Historical filenames keep the
// element code produced by their version's mapping; new filenames
// embed the new mapping. Surfaces in audit / coverage tooling so a
// `WL` element segment in the filename is unambiguously tied to a
// specific rule set.
const CONQUAS_MAPPING_VERSION = "v1";

// Map a raw `component` value (either a COMPONENT_GROUPS leaf OR one of
// the 17 AI categories in main.pb.js) to a CONQUAS IF element bucket.
// Derived-only — element is NOT stored on defects. Step 3 (evidence_role)
// will eventually supersede this client-side mapping.
//
// MAPPING_VERSION: see CONQUAS_MAPPING_VERSION above. Any change to the
// passthrough list, COMPONENT_BUCKET, or ME_BUCKET MUST bump the version.
function conquasElementOf(component) {
  if (!component) return CONQUAS_ELEMENT_OTHER;
  const c = String(component).trim();
  // Five IF elements share names with COMPONENT_GROUPS + AI categories.
  if (c === "Floor" || c === "Wall" || c === "Ceiling" || c === "Door" || c === "Window") return c;
  // "Component" bucket — sanitary ware, shower screens, mirrors, cabinetry
  // (CONQUAS §3.2(a) "Component" element).
  const COMPONENT_BUCKET = new Set([
    "Cabinet", "Wardrobe", "Countertop", "Shelf", "Vanity", "Door Frame", "Window Frame", "Timber Deck",
    "Toilet Bowl", "Urinal", "Basin", "Bidet", "Mirror", "Toilet Accessories", "Towel Rail",
    "Bathtub/Shower", "Basin/Sink", "Toilet/WC",
  ]);
  if (COMPONENT_BUCKET.has(c)) return "Component";
  // "M&E Fittings" — plumbing/electrical/ACMV/fire/lift fittings (CONQUAS §3.2(a)).
  const ME_BUCKET = new Set([
    "Plumbing", "Electrical", "Aircon", // AI categories
    "Tap/Faucet", "Water Heater", "Pipe", "Drain", "Floor Trap", "Valve",
    "Wiring", "Socket/Outlet", "Switch", "Light Fixture", "Distribution Board", "Cable Tray", "Earth/Grounding",
    "AC Unit", "FCU", "AHU", "Duct", "Diffuser/Grille", "Thermostat", "Condensate Pipe", "Chiller",
    "Sprinkler", "Fire Alarm", "Extinguisher", "Hose Reel", "Smoke Detector", "Emergency Light", "Exit Sign",
    "Lift Car", "Lift Door", "Lift Shaft", "Lift Motor", "Lift Button/Panel",
  ]);
  if (ME_BUCKET.has(c)) return "M&E Fittings";
  return CONQUAS_ELEMENT_OTHER;
}

// Two-letter IF element codes per docs/codification-standard.md §7 (ACTIVE
// v1.0 taxonomy). Used as the optional `element` segment in the ISO 19650
// photo-evidence tail so a filename like "...PROJ-...-A-PH-Z-...-S2-20260425_
// 01_FL_<hash>.jpg" carries the CONQUAS IF element without re-querying the
// record. Returns "" for the "Other" bucket so the segment is dropped (rather
// than embedded as a misleading code).
const CONQUAS_IF_ELEMENT_CODES = {
  "Floor": "FL", "Wall": "WL", "Ceiling": "CL", "Door": "DR",
  "Window": "WD", "Component": "CP", "M&E Fittings": "ME",
};
function conquasElementCode(elementName) {
  return CONQUAS_IF_ELEMENT_CODES[elementName] || "";
}

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
// Per-device safety brake on AI calls. Matches the Gemini free-tier
// published cap (1,500/day for gemini-*-flash) and the "1,500 photo
// analyses per day" copy shown in AI Setup, so users on the free tier
// never hit this gate before they hit Google's. Paid OpenAI / local
// Ollama users are bounded by the same number — the master AI on/off
// switch (AI_ENABLED_KEY) remains the kill switch for cost control.
const AI_DAILY_LIMIT = 1500;
// Master on/off switch for ALL AI calls — user-controlled token-spend gate.
// Stored as boolean; missing/undefined treated as ON (default) so existing
// setups keep working. Explicit `false` pauses every AI entry point; the
// provider credentials remain saved so the user can resume in one tap.
const AI_ENABLED_KEY = "sdt-ai-on";
// Gemini free-tier requests-per-day cap — informational only (shown in AI
// Setup so users understand the underlying provider limit). Bump if Google
// changes the published free-tier cap for gemini-*-flash.
const GEMINI_FREE_TIER_RPD = 1500;
// Per-photo cache of AI analysis results. Keyed by SHA-256 of photo bytes so
// the same photo (re-taken, re-uploaded, or kept across tab switches) reuses
// the prior result instead of burning tokens. Bump version when the prompt
// format changes so stale caches are ignored.
const AI_CACHE_VERSION = 1;
const AI_CACHE_PREFIX = `sdt-ai-cache-v${AI_CACHE_VERSION}-`;
const AI_CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const ONBOARDING_KEY = "sdt-onboarded";
const STORAGE_KEY = "sdt-storage-v1";
const GDRIVE_KEY = "sdt-gdrive-v1";
const AI_PROVIDER_KEY = "sdt-ai-provider-v1";
const OLLAMA_KEY = "sdt-ollama-v1";
const OPENAI_KEY = "sdt-openai-v1";
// Groq lives separately from OPENAI_KEY even though Groq exposes an
// OpenAI-compatible API. Splitting the storage lets a user configure both
// providers and switch between them in one tap, instead of overwriting
// the OpenAI cfg every time they want to try Groq.
const GROQ_KEY = "sdt-groq-v1";
const GMAPS_KEY = "sdt-gmaps-v1";
const MAP_PROVIDER_KEY = "sdt-map-provider-v1"; // "osm" | "gmaps"
// LOG auto-save mode — user preference for how aggressive AI auto-save is
// on the capture form. Three values:
//   "review-first": AI pre-fills + user taps SAVE (no auto-commit ever)
//   "review-then-auto": AI pre-fills + user taps SAVE for first 10 of a
//                       session, then zero-tap after (DEFAULT)
//   "always-auto":  AI pre-fills + auto-commits immediately (pre-existing
//                   zero-tap behaviour for firms that prefer speed)
// Session counts reset when the user leaves the LOG tab.
const AUTO_SAVE_MODE_KEY = "sdt-auto-save-mode-v1";
const AUTO_SAVE_MODE_DEFAULT = "review-then-auto";
const AUTO_SAVE_REVIEW_THRESHOLD = 10;
// REVIEW — overdue-only quick filter persistence + saved filter presets.
// Presets are stored as { [companyId::projectId]: [{name, filter, sevF, ...}] }
// so a user with multiple companies/projects keeps their bookmarks scoped.
const REVIEW_OVERDUE_ONLY_KEY = "sdt-review-overdue-only-v1";
const REVIEW_PRESETS_KEY = "sdt-review-presets-v1";
// Per-device REVIEW view-mode preference for the photo-gallery toggle.
// Only stores the GRID toggle; MAP is per-session (transient because it
// also depends on whether any entry has GPS coords).
const REVIEW_GRID_VIEW_KEY = "sdt-review-grid-view-v1";
// Company logo (base64 dataURL) for PDF cover branding. Stored as
// { [companyId]: dataURL } so a user with multiple companies sees the right
// logo on each report. Capped at ~200KB on upload to keep PDF bundles tiny.
const COMPANY_LOGO_KEY = "sdt-company-logo-v1";
// Per-user signature (base64 PNG dataURL) for the PDF SIGN-OFF block on
// reports the user exports. Stored as { [userId]: dataURL } so a shared
// device with multiple logins keeps each user's signature private. Drawn
// once via canvas in Profile, auto-embedded above the inspector line in
// every PDF export thereafter.
const MY_SIGNATURE_KEY = "sdt-my-signature-v1";
// In-app notification inbox — per-user event log derived client-side from
// defect timeline events (assignee changes, status changes, severity
// escalations, due-date changes). Computed by diffing the defects
// subscription tick against a per-user last-scan timestamp; events that
// target the current user (assignee/loggedBy match) are pushed in.
// Shape: { [authUserId]: { events: [...], lastScanAt: epochMs } }.
// Capped at INBOX_MAX events per user to bound localStorage growth.
const INBOX_KEY = "sdt-inbox-v1";
const INBOX_MAX = 50;
// Production-readiness diagnostics — see Settings → Help → Diagnostics.
// ERROR_LOG_KEY is a localStorage ring buffer of client-side errors caught
// by global window.onerror + window.onunhandledrejection handlers; capped at
// ERROR_LOG_MAX entries to bound storage. HEALTH_CHECK_KEY caches the most
// recent self-test result so users can show "last check: OK at <time>"
// without re-running. Both are user-exportable as JSON evidence packs for
// release-readiness reviews.
const ERROR_LOG_KEY = "sdt-error-log-v1";
const ERROR_LOG_MAX = 100;
const HEALTH_CHECK_KEY = "sdt-health-check-v1";
// Manual QA checklist — admin marks each key flow as tested per build.
// Persisted as { [buildCommit]: { [flowId]: {status, by, role, device, at} } }
// so a new build resets the checklist (forces fresh verification).
const QA_CHECKLIST_KEY = "sdt-qa-checklist-v1";
// Locally-tracked bug-resolved overlay. PocketBase `activity` rows of type
// "feedback" with feedbackType "bug" are the source; this localStorage map
// tracks which IDs an admin has marked resolved (with optional resolution
// note) so the bug tracker can show 0 open without losing the original
// record. Shape: { [activityId]: { resolvedAt, resolvedBy, note } }.
const BUG_RESOLVED_KEY = "sdt-bug-resolved-v1";
// Standard QA flow inventory — the manual checklist surfaced in the
// Diagnostics tab. Each entry has a stable id (used as the persistence
// key) and a translation key for the human-readable label. Adding new
// items here invalidates older checklists naturally — items not yet
// tested in the new build show as untested.
const QA_FLOWS = [
  { id: "log_capture",      labelKey: "qa.flow_log_capture" },
  { id: "log_gps_autotag",  labelKey: "qa.flow_log_gps" },
  { id: "log_ai_prefill",   labelKey: "qa.flow_log_ai" },
  { id: "tag_pin_place",    labelKey: "qa.flow_tag_pin" },
  { id: "tag_pdf_compare",  labelKey: "qa.flow_tag_compare" },
  { id: "review_filters",   labelKey: "qa.flow_review_filters" },
  { id: "review_grid",      labelKey: "qa.flow_review_grid" },
  { id: "review_map",       labelKey: "qa.flow_review_map" },
  { id: "review_bulk_edit", labelKey: "qa.flow_review_bulk" },
  { id: "report_pdf",       labelKey: "qa.flow_report_pdf" },
  { id: "report_csv",       labelKey: "qa.flow_report_csv" },
  { id: "report_email",     labelKey: "qa.flow_report_email" },
  { id: "report_signature", labelKey: "qa.flow_report_signature" },
  { id: "offline_capture",  labelKey: "qa.flow_offline_capture" },
  { id: "offline_replay",   labelKey: "qa.flow_offline_replay" },
  { id: "auth_signin",      labelKey: "qa.flow_auth" },
  { id: "inbox_routing",    labelKey: "qa.flow_inbox" },
  { id: "mention_tag",      labelKey: "qa.flow_mention" },
];
const MAP_DEFAULT_VIEW_KEY_PREFIX = "sdt-map-default-"; // + projectId
const MAP_FALLBACK_CENTER = { lat: 1.3331, lng: 103.7422, zoom: 17, label: "JEM Office Building" };
