// badgeConfig.js — RailTrans Expo 2026
"use strict";

const path = require("path");
const PAGE = { width: 400, height: 570 };
// Asset paths
const ASSETS_BG   = path.join(__dirname, "..", "assets", "bg");
const ASSETS_LOGO = path.join(__dirname, "..", "assets", "logos");

// ─── Top Strip ───────────────────────────────────────────────────────────────
const TOP_STRIP = { y: 0, height: 12 };

// ─── Header ──────────────────────────────────────────────────────────────────
const HEADER = {
  y:       12,
  height:  88,
  bgColor: "#F5EFD6",
};

// RailTrans logo — left side
const RAILTRANS_LOGO = {
  path:  path.join(ASSETS_LOGO, "railtranslogo.png"),
  x:     8,
  y:     16,
  width: 148,
};

// Bharat Mandapam logo — top-right (INCREASED SIZE)
const MANDAPAM = {
  path:  path.join(ASSETS_LOGO, "bharat_mandapam.png"),
  width: 85,
  x:     PAGE.width - 85 - 12,
  y:     18,
};

// Bharat Mandapam text under the logo (tighter + bigger)
const MANDAPAM_TEXT = {
  line1: "BHARAT MANDAPAM",
  line2: "NEW DELHI, INDIA",
  y: 60,
  fontSizeLine1: 8.2,
  fontSizeLine2: 8.2,
  lineGap: 2,
  color: "#555555",
};

// Date Pills (1, 2, 3) — CENTERED with JULY 2027
// The three pills together form a group; we center the whole group.
// Group width = 32 + gap + 32 + gap + 32 = 32*3 + 2*gap
// Let's use gap = 16 => group width = 96 + 32 = 128
// Center of page = 200. Group start x = 200 - 128/2 = 136
const DATE_PILLS = {
  pill1: { 
    text: "1", 
    x: 136, 
    y: 40,
    width: 32, 
    height: 32, 
    bgColor: "#d8031c",
    textColor: "#FFFFFF",
    fontSize: 18 
  },
  pill2: { 
    text: "2", 
    x: 184, 
    y: 40,
    width: 32, 
    height: 32, 
    bgColor: "#0d25c5",
    textColor: "#FFFFFF",
    fontSize: 18 
  },
  pill3: { 
    text: "3", 
    x: 232, 
    y: 40,
    width: 32, 
    height: 32, 
    bgColor: "#d8031c",
    textColor: "#FFFFFF",
    fontSize: 18 
  },
  // Month text centered under the date pills group
  // Group center = 136 + 128/2 = 200
  monthX: 136,      // same as pill1 x for width-based centering
  monthY: 76,
  venueY: 70,
};

// ─── Tagline Bar ─────────────────────────────────────────────────────────────
const TAGLINE = {
  y:               100,
  height:          24,
  bgColor:         "#000000",
  text:            "ASIA'S LARGEST EVENT FOR RAILWAY'S, TRANSPORTATION & SEMICONDUCTOR INDUSTRY",
  pillBgColor:     "#C8102E",
  pillBorderColor: "#C8102E",
  textColor:       "#FFFFFF",
  fontSize:        7,
};

// ─── Body ────────────────────────────────────────────────────────────────────
const BODY = {
  startY:         124,
  endY:           500, 
  bgColor:        "#D8EEF8",
  bgImage:        path.join(ASSETS_BG, "bg.jpeg"),
  overlayOpacity: 185,
};

// ─── QR Card ─────────────────────────────────────────────────────────────────
const QR_CARD = {
  width:       250, 
  height:      260, 
  get x()     { return (PAGE.width - this.width) / 2; },
  y:           138,
  radius:      10,
  bgColor:     "#FFFFFF",
  borderColor: "#CCCCCC",
  borderWidth: 0.8,
};

// QR is square; "wider" == slightly larger
const QR = { size: 168 };

// ─── Text Areas ──────────────────────────────────────────────────────────────
const TEXT_AREA = {
  nameY:           362,
  companyY:        380,
  nameFontSize:    16, 
  companyFontSize: 12,
  gapAfterQr:      22,
};

// ─── Footer: Left (CRI) + Right (Organised By) ──────────────────────────────
// Left side: Chamber of Railway Industries logo
const CRI_LOGO = {
  path:  path.join(ASSETS_LOGO, "cri_logo.png"),   // you'll need to add this asset
  x:     20,
  y:     418,
  width: 80,
};

// Right side: "ORGANISED BY" label + Urban Infra logo
const ORGANISED_BY = {
  label:          "ORGANISED BY",
  labelBgColor:   "#1B3A8A",
  labelTextColor: "#FFFFFF",
  labelFontSize:  9,
  // Right side positioning
  labelX:         240,       // right half
  labelY:         405,
  logoPath:       path.join(ASSETS_LOGO, "Urban_Infra_Group_Logo-HD.png"),
  logoX:          220,       // right half, centered under label
  logoY:          418,
  logoWidth:      130,
};

// ─── Ribbon ──────────────────────────────────────────────────────────────────
const RIBBON = {
  y: 510,
  height: 60,
  textSize: 32,
  borderRadius: 20,
  textColor: "#FFFFFF",
};

module.exports = {
  PAGE,
  TOP_STRIP,
  HEADER,
  RAILTRANS_LOGO,
  MANDAPAM,
  MANDAPAM_TEXT,
  DATE_PILLS,
  TAGLINE,
  BODY,
  QR_CARD,
  QR,
  TEXT_AREA,
  CRI_LOGO,
  ORGANISED_BY,
  RIBBON,
  ASSETS_BG,
  ASSETS_LOGO,
};