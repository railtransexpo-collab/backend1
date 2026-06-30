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
  // Drop it slightly to avoid sticking to the top edge
  // Keep it in the far-right column so it never overlaps the date/month text
  width: 85,
  x:     PAGE.width - 85-12,
  y:     18,
};

// Bharat Mandapam text under the logo (tighter + bigger)
const MANDAPAM_TEXT = {
  line1: "BHARAT MANDAPAM",
  line2: "NEW DELHI, INDIA",
  // Explicit Y so it never overwrites the logo
  y: 60,
  fontSizeLine1: 8.2,
  fontSizeLine2: 8.2,
  lineGap: 2,     // gap between line1 and line2
  color: "#555555",
};

// REMOVED: EDITION_PILL - No longer showing "6th EDITION"

// Date Pills (03 and 04 with WHITE text on RED background)
const DATE_PILLS = {
  pill1: { 
    text: "03", 
    x: 175, 
    y: 40,
    width: 34, 
    height: 34, 
    bgColor: "#d8031c",
    textColor: "#FFFFFF",
    fontSize: 18 
  },
  pill2: { 
    text: "04", 
    x: 214, 
    y: 40,
    width: 34, 
    height: 34, 
    bgColor: "#0d25c5",
    textColor: "#FFFFFF",
    fontSize: 18 
  },
  // Add breathing room from the Mandapam logo and keep alignment clean
  monthX: 238,
  monthY: 34,
  // Venue sits under the Mandapam logo with some gap
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
const QR = { size: 84 };

// ─── Text Areas ──────────────────────────────────────────────────────────────
const TEXT_AREA = {
  nameY:           362,
  companyY:        380,
  nameFontSize:    13, 
  companyFontSize: 12,
  // Extra spacing so name/company sit a bit lower
  gapAfterQr:      22,
};

// ─── Footer Logos with INCREASED SIZES and REDUCED WHITESPACE ─────────────────
const ORGANISED_BY = {
  label:          "ORGANISED BY",
  labelX:         20,
  labelY:         405,
  labelBgColor:   "#1B3A8A",
  labelTextColor: "#FFFFFF",
  labelFontSize:  9,        // INCREASED font size
  logoPath:       path.join(ASSETS_LOGO, "Urban_Infra_Group_Logo-HD.png"),
  logoX:          20,
  logoY:          418,
  logoWidth:      130,      // INCREASED width
};



// RIBBON - Reduced whitespace below
const RIBBON = {
  y: 510,           // MOVED UP (was 510) - reduces whitespace
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
  ORGANISED_BY,
  RIBBON,
  ASSETS_BG,
  ASSETS_LOGO,
};