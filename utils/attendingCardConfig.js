"use strict";

const path = require("path");

const ASSETS_DIR = path.join(__dirname, "..", "assets", "logos");
const ASSETS_BG  = path.join(__dirname, "..", "assets", "bg");

module.exports = {
  event: {
    name:  "7th RailTrans Expo 2027",
    dates: "1, 2 & 3 July, 2027",
    venue: "Bharat Mandapam, New Delhi",
    website: "https://www.railtransexpo.com",
  },

  card: {
    title: "ATTENDING CARD",
    shareMessage:
      "Register Now to Join me to explore collaborations and new business opportunities",
    websiteLabel: "www.railtransexpo.com",
    showPhoto: false,
    fields: { name: true, designation: true, company: true },
  },

  logos: {
    hostedBy: {
      label: "Hosted by",
      file:  path.join(ASSETS_DIR, "Urban_Infra_Group_Logo-HD.png"),
    },
    supportedBy: {
      label: "Supported by",
      file:  path.join(ASSETS_DIR, "Indian_Railway_Logo_2.png"),
    },
    association: {
      label: "In Association with",
      file:  path.join(ASSETS_DIR, "railchamber_logo.png"),   // ← Rail Chamber logo
    },
    railtransBrand: {
      file:  path.join(ASSETS_DIR, "railtranslogo.png"),
    },
  },

  qr: {
    enabled: true,
    value: "https://www.irmaindia.com",
    size: 100,
    margin: 0,
    errorCorrectionLevel: "M",
  },

  pdf: {
    size: "A4",
    layout: "portrait",
    margins: { top: 36, right: 36, bottom: 36, left: 36 },
  },

  colors: {
    background:  "#FFFFFF",
    navyBlue:    "#0e4d7d",
    gold:        "#c99a2e",
    text:        "#111827",
    nameText:    "#0f172a",
    subText:     "#475569",
    footerRed:   "#d61b2a",
    panelBorder: "#0e4d7d",
    panelBg:     "#FFFFFF",
    ribbonRed:   "#c8102e",
  },

  filename: {
    prefix: "RailTrans-Attending-Card",
    extension: ".pdf",
  },
};