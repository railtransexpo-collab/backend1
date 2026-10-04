// badgeConfig.js — RailTrans Expo 2026
"use strict";

const path = require("path");
const PAGE = { width: 400, height: 570 };

const ASSETS_BG   = path.join(__dirname, "..", "assets", "bg");
const ASSETS_LOGO = path.join(__dirname, "..", "assets", "logos");

// ─── Top Strip ───────────────────────────────────────────────────────────────
const TOP_STRIP = { y: 0, height: 12 };

// ─── Header ──────────────────────────────────────────────────────────────────
const HEADER = { y: 12, height: 88, bgColor: "#F5EFD6" };

// RailTrans logo — left side
const RAILTRANS_LOGO = {
  path:  path.join(ASSETS_LOGO, "railtranslogo.png"),
  x:     8,
  y:     16,
  width: 148,
};

// Bharat Mandapam logo — top-right
const MANDAPAM = {
  path:  path.join(ASSETS_LOGO, "bharat_mandapam.png"),
  width: 85,
  x:     PAGE.width - 85 - 12,
  y:     18,
};

const MANDAPAM_TEXT = {
  line1: "BHARAT MANDAPAM",
  line2: "NEW DELHI, INDIA",
  y: 60,
  fontSizeLine1: 8.2,
  fontSizeLine2: 8.2,
  lineGap: 2,
  color: "#555555",
};

// ═══════════════════════════════════════════════════════════════════════════
//  DATE PILLS 1 2 3  +  "JULY 2027"  →  treated as ONE centered block
//  Page center = 400/2 = 200
//  Pill group: 32 + 16 + 32 + 16 + 32 = 128  → starts at (200 - 64) = 136
//  "JULY 2027" uses the SAME 128-wide box so it centers under the pills
// ═══════════════════════════════════════════════════════════════════════════
const DATE_PILLS = {
  pill1: { text: "1", x: 136, y: 40, width: 32, height: 32,
           bgColor: "#d8031c", textColor: "#FFFFFF", fontSize: 18 },
  pill2: { text: "2", x: 184, y: 40, width: 32, height: 32,
           bgColor: "#0d25c5", textColor: "#FFFFFF", fontSize: 18 },
  pill3: { text: "3", x: 232, y: 40, width: 32, height: 32,
           bgColor: "#d8031c", textColor: "#FFFFFF", fontSize: 18 },

  // "JULY 2027" — box MUST match the pill group (128 wide, starting at 136)
  monthX: 136,
  monthWidth: 128,
  monthY: 76,
  monthText: "JULY 2027",
  monthFontSize: 16,
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

const QR = { size: 168 };

// ─── Text Areas ──────────────────────────────────────────────────────────────
const TEXT_AREA = {
  nameY:           362,
  companyY:        380,
  nameFontSize:    16,
  companyFontSize: 12,
  gapAfterQr:      22,
};

// ═══════════════════════════════════════════════════════════════════════════
//  FOOTER  —  two columns
//    LEFT  : Chamber of Railway Industries logo
//    RIGHT : "ORGANISED BY" pill + Urban Infra logo
// ═══════════════════════════════════════════════════════════════════════════
const CRI_LOGO = {
  path:  path.join(ASSETS_LOGO, "railchamber_logo.png"),   // ← same file as attending card
  x:     20,
  y:     410,
  width: 95,
};

const ORGANISED_BY = {
  label:          "ORGANISED BY",
  labelBgColor:   "#1B3A8A",
  labelTextColor: "#FFFFFF",
  labelFontSize:  9,
  labelY:         412,

  logoPath:       path.join(ASSETS_LOGO, "Urban_Infra_Group_Logo-HD.png"),
  logoWidth:      120,
  // right side
  logoX:          245,
  logoY:          432,
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
  PAGE, TOP_STRIP, HEADER, RAILTRANS_LOGO, MANDAPAM, MANDAPAM_TEXT,
  DATE_PILLS, TAGLINE, BODY, QR_CARD, QR, TEXT_AREA,
  CRI_LOGO, ORGANISED_BY, RIBBON, ASSETS_BG, ASSETS_LOGO,
};