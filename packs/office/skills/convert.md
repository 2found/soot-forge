# Optional native Office conversion

`office_convert` uses the absolute LibreOffice executable from host-owned
`OFFICE_BINDING`. Installation does not install Office or grant this tool.
Use it for legacy `.doc/.xls/.ppt`, OpenDocument files, Office-to-PDF export
and Excel recalculation. Target output is `.docx/.xlsx/.pptx/.pdf`.

The runner uses a new temporary LibreOffice profile, no shell interpolation,
a fixed timeout and a new destination. Unsupported conversion or missing
binary fails explicitly. Open the converted artifact and compare formatting,
page count, fonts, formulas, chart/table values and notes; conversion is not a
promise of Microsoft Office fidelity. Untrusted documents require an
operator-controlled isolated rendering environment; workspace paths alone
are not an operating-system sandbox.
