"use strict";

const path = require("path");

/**
 * RailTrans Expo 2027
 * Attending Card configuration
 *
 * This file contains ONLY configuration.
 * PDF rendering/layout stays inside attendingCardGenerator.js.
 */

const ASSETS_DIR = path.join(__dirname, "..", "assets", "logos");

module.exports = {
  event: {
    name: "7th RailTrans Expo 2027",
    dates: "1, 2 & 3 July, 2027",
    venue: "Bharat Mandapam, New Delhi",
    website: "https://www.railtransexpo.com",
  },

  /**
   * Attending Card content
   */
  card: {
    title: "ATTENDING CARD",

    shareMessage:
      "Register Now to Join me to explore collaborations and new business opportunities",

    websiteLabel: "www.railtransexpo.com",

    /**
     * No participant photograph.
     */
    showPhoto: false,

    /**
     * Fields displayed on the card.
     */
    fields: {
      name: true,
      designation: true,
      company: true,
    },
  },

  /**
   * Logos requested by the client.
   *
   * IMPORTANT:
   * Replace these filenames with the EXACT filenames
   * that exist inside backend/assets/logos/.
   */
  logos: {
    hostedBy: {
      label: "Hosted by",
      file: path.join(ASSETS_DIR, "urban-infra-group.png"),
    },

    supportedBy: {
      label: "Supported by",
      file: path.join(ASSETS_DIR, "ministry-of-railways.png"),
    },

    association: {
      label: "Association with",
      file: path.join(ASSETS_DIR, "chamber-logo.png"),
    },
  },

  /**
   * QR configuration.
   *
   * The QR should point to the RailTrans Expo website.
   */
  qr: {
    enabled: true,
    value: "https://www.railtransexpo.com",
    size: 150,
    margin: 0,
    errorCorrectionLevel: "M",
  },

  /**
   * PDF configuration.
   *
   * Portrait poster/card format.
   */
  pdf: {
    size: "A4",
    layout: "portrait",

    margins: {
      top: 36,
      right: 36,
      bottom: 36,
      left: 36,
    },

    titleFontSize: 22,
    nameFontSize: 28,
    designationFontSize: 16,
    companyFontSize: 17,
    messageFontSize: 16,
    websiteFontSize: 12,
  },

  /**
   * General visual configuration.
   *
   * Keep colors here so the generator does not contain
   * hard-coded design configuration.
   */
  colors: {
    background: "#FFFFFF",
    primary: "#0B4F60",
    secondary: "#1F2937",
    text: "#111827",
    muted: "#6B7280",
    border: "#D1D5DB",
  },

  /**
   * Layout configuration.
   */
  layout: {
    /**
     * Top logos:
     *
     * Hosted by       Association       Supported by
     *    LEFT             CENTER             RIGHT
     */
    topLogos: {
      enabled: true,
      height: 55,
      sideWidth: 150,
      centerWidth: 180,
    },

    /**
     * Participant information is centered.
     */
    participant: {
      centered: true,
      nameMarginTop: 24,
      designationMarginTop: 8,
      companyMarginTop: 5,
    },

    /**
     * Share/registration message.
     */
    message: {
      centered: true,
      marginTop: 30,
      maxWidth: 440,
    },

    /**
     * QR code section.
     */
    qr: {
      centered: true,
      marginTop: 22,
      labelMarginTop: 8,
    },

    /**
     * Website.
     */
    website: {
      centered: true,
      marginTop: 12,
    },
  },

  /**
   * Filename used when downloading the PDF.
   */
  filename: {
    prefix: "RailTrans-Attending-Card",
    extension: ".pdf",
  },
};