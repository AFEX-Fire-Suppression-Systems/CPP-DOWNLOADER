# Compact Panel Log Export Web App

This folder contains a static web app intended for **GitHub Pages** deployment.

## Features
- Connect to a COM port from the browser using the Web Serial API.
- Send `EXPORT_LOGS` to the connected device.
- Display incoming serial data live.
- Save and download the full captured log as a `.txt` file.

## Requirements
- Chromium-based browser (Chrome, Edge) with Web Serial support.
- Served over HTTPS (GitHub Pages satisfies this).
- User interaction is required to choose and open the serial port.

## Deploy to GitHub Pages
1. Push this repository to GitHub.
2. In GitHub, open **Settings > Pages**.
3. Set source to your branch (for example `main`) and folder `/web` (or `/(root)` if you move files).
4. Save and open the published Pages URL.

## Use
1. Open the page.
2. Set baud rate (default `115200`).
3. Click **Connect COM Port** and pick the device.
4. Click **Send EXPORT_LOGS**.
5. Watch the live output.
6. Click **Download Log** to save the captured data.
