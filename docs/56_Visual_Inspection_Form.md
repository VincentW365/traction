# Visual Inspection Form

> Source: stakeholder checklist (`inspection form.webp`). This is the cleaned form —
> **title + check‑off only**, with the job‑card information‑request header removed.
> It doubles as the build spec for the Phase C digital inspection form.

**Check one per item:**  ☐ **OK** (Checked and Okay) · ☐ **FUTURE** (May Need Future Attention) · ☐ **IMMEDIATE** (Requires Immediate Attention)

---

## Interior / Exterior
| Item | OK | FUTURE | IMMEDIATE |
|---|:--:|:--:|:--:|
| Head Lights / Tail Lights / Turn Signals / Brake Lights / Hazard Warning Lights / Exterior Lamps / License Plate Lights | ☐ | ☐ | ☐ |
| Windshield Washer Spray / Wiper Operation / Wiper Blades | ☐ | ☐ | ☐ |
| Windshield Condition (inspect for cracks, chips, or pitting) | ☐ | ☐ | ☐ |
| Mirrors / Glass | ☐ | ☐ | ☐ |
| Emergency Brake Adjustment | ☐ | ☐ | ☐ |
| Horn Operation | ☐ | ☐ | ☐ |
| Fuel Tank Cap Gasket | ☐ | ☐ | ☐ |
| Air Conditioning Filter (if equipped) | ☐ | ☐ | ☐ |
| Clutch Operation (if equipped) | ☐ | ☐ | ☐ |
| Back‑up Lights Left / Right | ☐ | ☐ | ☐ |
| Dash Warning Lights | ☐ | ☐ | ☐ |
| Carpet / Upholstery / Floor Mats | ☐ | ☐ | ☐ |

## Battery
| Item | OK | FUTURE | IMMEDIATE |
|---|:--:|:--:|:--:|
| Battery Terminals / Cables / Mountings | ☐ | ☐ | ☐ |
| Check Condition of Battery (storage capacity test) | ☐ | ☐ | ☐ |

- Battery test result:  ☐ Pass  ☐ Recharge & Retest  ☐ Fail
- Factory spec cold cranking amps: __________   Actual cold cranking amps: __________

## Under Vehicle
| Item | OK | FUTURE | IMMEDIATE |
|---|:--:|:--:|:--:|
| Shock Absorbers / Suspension / Struts | ☐ | ☐ | ☐ |
| Steering Gear Box / Linkage and Boots / Ball Joints / Dust Covers | ☐ | ☐ | ☐ |
| Muffler / Exhaust Pipes / Mountings / Catalytic Converter | ☐ | ☐ | ☐ |
| Engine Oil and/or Fluid Leaks | ☐ | ☐ | ☐ |
| Brake Lines / Hoses / Parking Brake Cable | ☐ | ☐ | ☐ |
| Drive Shaft Boots / CV Boots / U‑joints / Transmission Linkage (if equipped) | ☐ | ☐ | ☐ |
| Transmission / Differential / Transfer Case (check fluid level, condition, leaks) | ☐ | ☐ | ☐ |
| Fuel Lines and Connections / Fuel Tank Band / Fuel Tank Vapor Vent System Hoses | ☐ | ☐ | ☐ |
| Inspect Nuts and Bolts on Body Chassis | ☐ | ☐ | ☐ |

## Under Hood
| Item | OK | FUTURE | IMMEDIATE |
|---|:--:|:--:|:--:|
| Fluid Levels: Oil / Coolant / Battery / Power Steering / Brake / Washer / Automatic Transmission | ☐ | ☐ | ☐ |
| Engine Air Filter | ☐ | ☐ | ☐ |
| Drive Belts (condition and adjustment) | ☐ | ☐ | ☐ |
| Cooling System Hoses / Heater Hoses / A/C Hoses and Connections | ☐ | ☐ | ☐ |
| Radiator Core / A/C Condenser (if equipped) | ☐ | ☐ | ☐ |
| Coolant Recovery Reservoir Fluid Level / Condition | ☐ | ☐ | ☐ |
| Clutch Reservoir Fluid / Condition (as equipped) | ☐ | ☐ | ☐ |

## Brake and Tire
Per wheel — record measurements and condition:

| Position | Brake Lining (mm) | Tire Tread (32nds) | Wear Pattern | Tire Pressure (PSI) Before → After | Rotor / Drum |
|---|---|---|---|---|---|
| Left Front | ______ | ______ | __________ | ______ → ______ | ☐ Rotor ☐ Drum |
| Right Front | ______ | ______ | __________ | ______ → ______ | ☐ Rotor ☐ Drum |
| Left Rear | ______ | ______ | __________ | ______ → ______ | ☐ Rotor ☐ Drum |
| Right Rear | ______ | ______ | __________ | ______ → ______ | ☐ Rotor ☐ Drum |

- ☐ Alignment Check Needed  ☐ Wheel Balance Needed  ☐ Brake Inspection Not Performed This Visit

## Prior Body Damage
Mark existing damage on the vehicle diagram (front / rear / both sides / roof). *(Diagram to be reproduced from the original form.)*

- **X** ______________________  Advisor
- **X** ______________________  Customer Acknowledgement

## Comments / Estimates
```
______________________________________________________________
______________________________________________________________
______________________________________________________________
______________________________________________________________
```

---

### Notes for Phase C (digital build)
- Three‑state per item (`OK` / `FUTURE` / `IMMEDIATE`) maps cleanly to a per‑line inspection result enum; `FUTURE`/`IMMEDIATE` items become the **findings → recommendations → customer decision** the roadmap folds into the inspection.
- Brake/tire are **measurements** (numbers), not three‑state — model as numeric fields per wheel.
- Sign‑off = **Senior Technician (Advisor)** + **Customer Acknowledgement** (the digital sign‑off in the roadmap).
- The colour‑coded layout + body‑damage diagram in `inspection form.webp` are presentation; the data model is the table content above.
