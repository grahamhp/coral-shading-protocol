# Coral Shading Protocol (CSP)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.2-blue.svg)](https://github.com/yourusername/repo-name)

**A web-based modeling tool for designing shading regimes for coral conservation, restoration, and photobiology experiments.**

The **Coral Shading Protocol (CSP)** tool is designed to help practitioners plan effective light management strategies for coral nurseries, outplanting sites, and experimental tanks. It allows users to model underwater light fields based on site-specific data, calculating Daily Light Integrals (DLI) and categorizing energy into biological growth zones based on species-specific photophysiology.

The tool contrasts **Constant Shading** (standard shade cloth/mesh) with **Dynamic Shading** (active management or sized 100% opaque shading to affect peak solar irradiance) to identify the most effective strategy for minimizing stress while supporting energy budget.

## 🔗 Live Demo
[**Click here to use the tool online**](https://grahamhp.github.io/coral-shading-protocol/)

## ✨ Key Features

* **Irradiance Modeling:** Import hourly Direct ($G_b$) and Diffuse ($G_d$) irradiance data (compatible with PVGIS) to model site-specific light fields.
* **Physics Engine:**
    * Calculates **Fresnel Reflection** losses at the air-water interface based on solar zenith angle.
    * Applies **Depth Attenuation** using the Beer-Lambert law and diffuse attenuation coefficient ($K_d$).
    * Models **Diffuse Transmittance** for opaque objects floating on the water surface.
* **Biological Integration:** Calculates energy budgets based on species-specific parameters:
    * Light Compensation Points (LCP)
    * Light Saturation Points (LSP)
    * Photoinhibition Thresholds (PIT)
* **Comparative Statistics:** Instantly compares DLI, Optimal Growth, and Inhibition percentages between Unshaded, Constant, and Dynamic regimes to inform restoration planning.
* **Interactive Visualization:** Real-time plotting of PAR curves using Chart.js.

## 🚀 Usage Guide

### 1. Data Input
Gather hourly average irradiance data for your restoration or study site. We recommend using [PVGIS](https://re.jrc.ec.europa.eu/pvg_tools/en/) to generate averages for your specific months of interest over the last 3 years.

### 2. Physical Parameters
* **Surface Reflection:** Enable if using satellite/weather station data ("In-Air"). Disable if using underwater sensor data.
* **Target Reduction:** Set your conservation goal (e.g., "Reduce total DLI by 30% to mitigate bleaching risk").
* **Depth & Attenuation:** Input the depth of your nursery/site and the water turbidity ($K_d$).

### 3. Biological Parameters
Input the photophysiological parameters of your target coral species ($LCP$, $LSP$, $PIT$). The tool uses these to determine how much "useful" vs. "stressful" light the coral receives under different regimes.

## 🧮 Scientific Basis

The tool operates on the following principles:

1.  **Fresnel Reflection:** Calculates the angle-dependent transmission of the direct solar beam and the constant reflection of the diffuse sky (approx 6.6%).
2.  **Beer-Lambert Law:** $I_z = I_0 \cdot e^{-K_d \cdot z}$
3.  **Shading Logic:**
    * *Constant:* Uniform reduction of scalar irradiance (simulating mesh/cloth).
    * *Dynamic:* Binary exclusion of Direct Beam ($G_b$) during the calculated window, with partial transmittance of Diffuse light ($G_d$).

## 💻 Installation (Running Locally)

Since this tool is a standalone static web application, no installation is required.

1.  Clone or download this repository.
2.  Open `index.html` in any modern web browser (Chrome, Firefox, Safari, Edge).
3.  The application runs entirely client-side; no server or internet connection is needed after downloading.

## 🤝 Contributing

Contributions are welcome! If you have suggestions for improving the physics model or the interface:
1.  Fork the project.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.

## 📄 Citation

If you use this tool for research, conservation planning, or restoration projects, please cite it as:

> **Patterson, Graham** (2026). *Coral Shading Protocol (CSP) Web Application v3.2*. REEF Scuba. Available at: https://grahamhp.github.io/coral-shading-protocol/

## 👤 Author

**Graham Patterson**
* Organization: [REEF Scuba](https://www.reef-scuba.org)
* Email: [graham@reef-scuba.org](mailto:graham@reef-scuba.org)
* Support: [Buy me a coffee](https://buymeacoffee.com/coralgraham)

---
*Distributed under the MIT License. See `LICENSE` for more information.*
