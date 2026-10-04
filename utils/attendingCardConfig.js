"use strict";

const path = require("path");

/**
 * RailTrans Expo 2027
 * Attending Card configuration
 */

const ASSETS_DIR = path.join(__dirname, "..", "assets", "logos");
const ASSETS_BG  = path.join(__dirname, "..", "assets", "bg");

module.exports = {
  event: {
    name: "7th RailTrans Expo 2027",
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
    fields: {
      name: true,
      designation: true,
      company: true,
    },
  },

  logos: {
    hostedBy: {
      label: "Hosted by",
      file: path.join(ASSETS_DIR, "Urban_Infra_Group_Logo-HD.png"),
    },
    supportedBy: {
      label: "Supported by",
      file: path.join(ASSETS_DIR, "Indian_Railway_Logo_2.png"),
    },
    association: {
      label: "In Association with",
      file: path.join(ASSETS_DIR, "railchamber_logo.png"),
    },
    railtransBrand: {
      file: path.join(ASSETS_DIR, "railtranslogo.png"),
    },
  },

  qr: {
    enabled: true,
    value: "https://www.irmaindia.com",
    size: 120,
    margin: 0,
    errorCorrectionLevel: "M",
  },

  pdf: {
    size: "A4",
    layout: "portrait",
    margins: { top: 36, right: 36, bottom: 36, left: 36 },
  },

  colors: {
    background:    "#FFFFFF",
    primary:       "#0B4F60",
    navyBlue:      "#0e4d7d",
    secondary:     "#1F2937",
    text:          "#111827",
    nameText:      "#0f172a",
    subText:       "#475569",
    muted:         "#6B7280",
    border:        "#D1D5DB",
    footerRed:     "#d61b2a",
    panelBorder:   "#0e4d7d",
    panelBg:       "#FFFFFF",
  },

  layout: {
    topLogos: {
      enabled: true,
      height: 55,
      sideWidth: 130,
      centerWidth: 180,
    },
    participant: {
      centered: true,
      nameMarginTop: 24,
      designationMarginTop: 8,
      companyMarginTop: 5,
    },
    message: {
      centered: true,
      marginTop: 30,
      maxWidth: 440,
    },
    qr: {
      centered: true,
      marginTop: 22,
      labelMarginTop: 8,
    },
    website: {
      centered: true,
      marginTop: 12,
    },
  },

  filename: {
    prefix: "RailTrans-Attending-Card",
    extension: ".pdf",
  },
};