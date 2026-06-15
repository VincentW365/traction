# Generates a high-fidelity, INTERACTIVE Visual Vehicle Inspection Report as a .docx
# using Word COM automation. Clickable checkbox content controls (green/yellow/red),
# shaded section bars, brake/tire grid, signatures. Standalone document (not the webapp).
# Output: repo-root Visual_Inspection_Form.docx. Re-run any time to regenerate.
$ErrorActionPreference = 'Stop'
$OUT = 'C:\Users\vwilson\Desktop\Projects\Traction\Visual_Inspection_Form.docx'
$TIRE = 'C:\Users\vwilson\Desktop\Projects\Traction\tire.webp'
$CAR = 'C:\Users\vwilson\Desktop\Projects\Traction\car.webp'

function Bgr([int]$r, [int]$g, [int]$b) { return $r + ($g * 256) + ($b * 65536) }
$GREEN = Bgr 22 163 74;  $LGREEN = Bgr 220 252 231
$YELLOW = Bgr 202 138 4; $LYELLOW = Bgr 254 249 195
$RED = Bgr 220 38 38;    $LRED = Bgr 254 226 226
$BLACK = Bgr 17 24 39;   $WHITE = 16777215; $GREY = Bgr 241 245 249

$INTERIOR = @(
  'Head Lights / Tail Lights / Turn Signals / Brake Lights / Hazard Warning Lights / Exterior Lamps / License Plate Lights',
  'Windshield Washer Spray / Wiper Operation / Wiper Blades',
  'Windshield Condition (inspect for cracks, chips, or pitting)',
  'Mirrors / Glass', 'Emergency Brake Adjustment', 'Horn Operation', 'Fuel Tank Cap Gasket',
  'Air Conditioning Filter (if equipped)', 'Clutch Operation (if equipped)',
  'Back-up Lights Left / Right', 'Dash Warning Lights', 'Carpet / Upholstery / Floor Mats')
$BATTERY = @('Battery Terminals / Cables / Mountings', 'Check Condition of Battery (storage capacity test)')
$UNDERVEHICLE = @(
  'Shock Absorbers / Suspension / Struts', 'Steering Gear Box / Linkage and Boots / Ball Joints / Dust Covers',
  'Muffler / Exhaust Pipes / Mountings / Catalytic Converter', 'Engine Oil and/or Fluid Leaks',
  'Brake Lines / Hoses / Parking Brake Cable', 'Drive Shaft Boots / CV Boots / U-joints / Transmission Linkage (if equipped)',
  'Transmission / Differential / Transfer Case (check fluid level, condition, leaks)',
  'Fuel Lines and Connections / Fuel Tank Band / Fuel Tank Vapor Vent System Hoses', 'Inspect Nuts and Bolts on Body Chassis')
$UNDERHOOD = @(
  'Fluid Levels: Oil / Coolant / Battery / Power Steering / Brake / Washer / Automatic Transmission',
  'Engine Air Filter', 'Drive Belts (condition and adjustment)',
  'Cooling System Hoses / Heater Hoses / A/C Hoses and Connections', 'Radiator Core / A/C Condenser (if equipped)',
  'Coolant Recovery Reservoir Fluid Level / Condition', 'Clutch Reservoir Fluid / Condition (as equipped)')

$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Add()
  $ps = $doc.PageSetup; $ps.TopMargin = 30; $ps.BottomMargin = 30; $ps.LeftMargin = 40; $ps.RightMargin = 40
  $sel = $word.Selection
  $sel.Font.Name = 'Calibri'

  function NL() { $word.Selection.TypeParagraph() }
  function GoEnd() { $word.Selection.EndKey(6) | Out-Null }  # wdStory
  function AddCk($cell) {
    $cell.Range.ParagraphFormat.Alignment = 1
    $cell.Select()
    $word.Selection.Collapse(1)  # wdCollapseStart -> insertion point at cell start
    [void]$doc.ContentControls.Add(8)  # 8 = wdContentControlCheckBox (clickable), inserted at selection
  }
  function CkRow($labels) {
    # A row of [clickable checkbox][label] pairs, built as a borderless table so the
    # in-cell checkbox approach (which works reliably) is reused instead of inline inserts.
    $word.Selection.EndKey(6) | Out-Null
    $t = $doc.Tables.Add($word.Selection.Range, 1, $labels.Count * 2)
    $t.Borders.Enable = $false; $t.Range.Font.Size = 9
    for ($i = 0; $i -lt $labels.Count; $i++) {
      AddCk $t.Cell(1, $i * 2 + 1)
      $t.Cell(1, $i * 2 + 2).Range.Text = $labels[$i]
    }
    $t.AutoFitBehavior(1) | Out-Null  # wdAutoFitContent -> shrink columns to content
    GoEnd; NL
  }

  # Title
  $sel.ParagraphFormat.Alignment = 1
  $sel.Font.Size = 9; $sel.Font.Bold = $true; $sel.Font.Color = Bgr 71 85 105
  $sel.TypeText("BERT'S AUTO PARTS SERVICE CENTRE"); NL
  $sel.Font.Size = 20; $sel.Font.Color = 0
  $sel.TypeText('VISUAL VEHICLE INSPECTION REPORT'); NL
  $sel.Font.Size = 10; $sel.Font.Bold = $false; $sel.ParagraphFormat.Alignment = 0

  # Header fields
  $sel.TypeText('Customer: ______________________________   Technician: ____________________   Date: ____________'); NL
  $sel.TypeText('Yr./Make/Model: ____________________   Plate / Tag #: ____________   Repair Order #: ____________'); NL
  $sel.TypeText('Mileage: ____________   Chassis / VIN: ________________________________________________'); NL; NL

  # Legend (1x3 colored table)
  $lg = $doc.Tables.Add($sel.Range, 1, 3); $lg.Borders.Enable = $false
  $leg = @(@('CHECKED AND OKAY', $GREEN, $WHITE), @('MAY NEED FUTURE ATTENTION', $YELLOW, 0), @('REQUIRES IMMEDIATE ATTENTION', $RED, $WHITE))
  for ($i = 0; $i -lt 3; $i++) {
    $cell = $lg.Cell(1, $i + 1); $cell.Shading.BackgroundPatternColor = $leg[$i][1]
    $cell.Range.Font.Bold = $true; $cell.Range.Font.Size = 9; $cell.Range.Font.Color = $leg[$i][2]
    $cell.Range.ParagraphFormat.Alignment = 1; $cell.Range.Text = $leg[$i][0]
  }
  GoEnd; NL

  function Checklist($title, $items) {
    $word.Selection.EndKey(6) | Out-Null
    $rows = $items.Count + 2
    $tbl = $doc.Tables.Add($word.Selection.Range, $rows, 4)
    $tbl.Borders.Enable = $true; $tbl.Range.Font.Size = 9; $tbl.AllowAutoFit = $false
    $tbl.Columns.Item(1).Width = 30; $tbl.Columns.Item(2).Width = 30; $tbl.Columns.Item(3).Width = 30; $tbl.Columns.Item(4).Width = 425
    # Row 1: merged section title bar
    $tbl.Cell(1, 1).Merge($tbl.Cell(1, 4))
    $t = $tbl.Cell(1, 1); $t.Shading.BackgroundPatternColor = $BLACK
    $t.Range.Font.Bold = $true; $t.Range.Font.Color = $WHITE; $t.Range.Font.Size = 10; $t.Range.Text = $title.ToUpper()
    # Row 2: column headers
    $hdr = @(@('OK', $LGREEN), @('FUT', $LYELLOW), @('IMM', $LRED), @('ITEM', $GREY))
    for ($c = 1; $c -le 4; $c++) {
      $h = $tbl.Cell(2, $c); $h.Shading.BackgroundPatternColor = $hdr[$c - 1][1]
      $h.Range.Font.Bold = $true; $h.Range.Font.Size = 8; $h.Range.ParagraphFormat.Alignment = 1; $h.Range.Text = $hdr[$c - 1][0]
    }
    for ($i = 0; $i -lt $items.Count; $i++) {
      $r = $i + 3
      $tbl.Cell($r, 1).Shading.BackgroundPatternColor = $LGREEN
      $tbl.Cell($r, 2).Shading.BackgroundPatternColor = $LYELLOW
      $tbl.Cell($r, 3).Shading.BackgroundPatternColor = $LRED
      $tbl.Cell($r, 4).Range.Text = $items[$i]
      AddCk $tbl.Cell($r, 1); AddCk $tbl.Cell($r, 2); AddCk $tbl.Cell($r, 3)
    }
    GoEnd; NL
  }

  Checklist 'Interior / Exterior' $INTERIOR
  Checklist 'Battery' $BATTERY
  # Battery extras line with clickable boxes
  GoEnd; $word.Selection.Font.Size = 9; $word.Selection.Font.Bold = $true; $word.Selection.TypeText('Battery test:'); $word.Selection.Font.Bold = $false; NL
  CkRow @('Pass', 'Recharge & Retest', 'Fail')
  GoEnd; $word.Selection.Font.Size = 9; $word.Selection.TypeText('Factory CCA: ________   Actual CCA: ________'); NL; NL

  Checklist 'Under Vehicle' $UNDERVEHICLE
  Checklist 'Under Hood' $UNDERHOOD

  # Brake & Tire
  GoEnd; $word.Selection.EndKey(6) | Out-Null
  $bt = $doc.Tables.Add($word.Selection.Range, 5, 7); $bt.Borders.Enable = $true; $bt.Range.Font.Size = 8; $bt.AllowAutoFit = $false
  $bt.Cell(1, 1).Merge($bt.Cell(1, 7)); $b0 = $bt.Cell(1, 1)
  $b0.Shading.BackgroundPatternColor = $BLACK; $b0.Range.Font.Bold = $true; $b0.Range.Font.Color = $WHITE; $b0.Range.Font.Size = 10; $b0.Range.Text = 'BRAKE AND TIRE'
  $bth = @('Wheel', 'Brake Lining (mm)', 'Tire Tread (32nds)', 'Wear Pattern', 'PSI Before', 'PSI After', 'Rotor / Drum')
  for ($c = 1; $c -le 7; $c++) { $h = $bt.Cell(2, $c); $h.Shading.BackgroundPatternColor = $GREY; $h.Range.Font.Bold = $true; $h.Range.Text = $bth[$c - 1] }
  $wheels = @('Left Front', 'Right Front', 'Left Rear', 'Right Rear')
  for ($i = 0; $i -lt 4; $i++) { $bt.Cell($i + 3, 1).Range.Text = $wheels[$i] }
  # Tire illustration — floating, centered over the brake/tire grid (as in the reference form).
  $tireShape = $doc.Shapes.AddPicture($TIRE, $false, $true, 0, 0, 92, 61, $bt.Cell(3, 4).Range)
  $tireShape.LockAspectRatio = -1
  $tireShape.Width = 92
  $tireShape.WrapFormat.Type = 3            # wdWrapNone (float, no text wrap)
  $tireShape.RelativeHorizontalPosition = 0 # wdRelativeHorizontalPositionMargin
  $tireShape.Left = -999995                 # wdShapeCenter -> centered horizontally
  $tireShape.RelativeVerticalPosition = 3   # wdRelativeVerticalPositionParagraph (anchored in the grid)
  $tireShape.Top = -2
  $tireShape.ZOrder(0)                       # msoBringToFront -> in front of the grid
  GoEnd; NL
  CkRow @('Alignment Check Needed', 'Wheel Balance Needed', 'Brake Inspection Not Performed This Visit'); NL

  # Prior body damage + comments
  function BarThenBox($title, $h) {
    $word.Selection.EndKey(6) | Out-Null
    $tb = $doc.Tables.Add($word.Selection.Range, 2, 1); $tb.Borders.Enable = $true
    $tt = $tb.Cell(1, 1); $tt.Shading.BackgroundPatternColor = $BLACK; $tt.Range.Font.Bold = $true; $tt.Range.Font.Color = $WHITE; $tt.Range.Font.Size = 10; $tt.Range.Text = $title.ToUpper()
    $tb.Cell(2, 1).Height = $h; $tb.Rows.Item(2).Height = $h
    GoEnd; NL
  }
  # Prior Body Damage — black bar + the car diagram filling the box (as in the reference form).
  $word.Selection.EndKey(6) | Out-Null
  $pb = $doc.Tables.Add($word.Selection.Range, 2, 1); $pb.Borders.Enable = $true
  $pt = $pb.Cell(1, 1); $pt.Shading.BackgroundPatternColor = $BLACK; $pt.Range.Font.Bold = $true; $pt.Range.Font.Color = $WHITE; $pt.Range.Font.Size = 10; $pt.Range.Text = 'PRIOR BODY DAMAGE (mark / describe existing damage)'
  $pbox = $pb.Cell(2, 1); $pbox.Range.ParagraphFormat.Alignment = 1
  $carImg = $pbox.Range.InlineShapes.AddPicture($CAR, $false, $true)
  $carImg.LockAspectRatio = -1
  $carImg.Width = 200
  GoEnd; NL
  BarThenBox 'Comments / Estimates' 90

  # Signatures
  GoEnd; $sel = $word.Selection; $sel.Font.Size = 10
  $sel.TypeText('X ____________________________   Senior Technician / Advisor          X ____________________________   Customer Acknowledgement'); NL

  $doc.SaveAs2($OUT, 16)  # 16 = wdFormatDocumentDefault (.docx)
  $cc = $doc.ContentControls.Count
  $doc.Close(0)
  Write-Output ("DOCX_OK path=$OUT checkboxes=$cc")
}
finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
