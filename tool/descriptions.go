package main

// descriptions.go is the text under the property panel: what a property or
// an event does, as the Visual Studio property grid says it in the box below
// the grid. It is served with the catalog (each type gets the entries for
// its own properties and events), so the webview has nothing to keep in
// step.
//
// One table per kind of name rather than per type: a property called
// `placeholder` means the same thing on a TextBox as on a ComboBox, and a
// Click is a Click everywhere. A type whose property means something of its
// own overrides the entry in typeDescriptions.

var propDescriptions = map[string]string{
	"anchor":    "The edges of the container this control keeps its distance to when the container is resized.",
	"dock":      "Which edge of the container the control is glued to, filling it along that edge; Fill takes what the docked siblings leave.",
	"tabIndex":  "The order the Tab key visits the controls in. Lower numbers come first.",
	"tabStop":   "Whether the Tab key stops on this control.",
	"visible":   "Whether the control is shown. A hidden control is still drawn in the designer, faded, so it can be selected.",
	"enabled":   "Whether the control responds to the user. A disabled control is drawn greyed out.",
	"foreColor": "The color of the control's text. Only controls that draw their own text (Label, GroupBox's caption) can show it; the rest keep the theme's.",
	"backColor": "The color behind the control's content. Panels and layout panels paint it; Fyne's own widgets keep the theme's.",
	"font":      "The family, size and style of the control's text. Applied by the controls that draw their own text (Label, GroupBox's caption).",
	"padding":   "The inset inside the control that its children are laid out in: one number for every side, or left, top, right, bottom.",

	"text":                  "The text the control shows.",
	"placeholder":           "The hint shown in the box while it is empty.",
	"checked":               "Whether the box starts checked.",
	"mask":                  "The input mask: 0 is a required digit, 9 an optional one, L a letter, A a letter or digit; anything else is shown as is.",
	"wordWrap":              "Whether long lines wrap at the edge of the box instead of scrolling sideways.",
	"smallChange":           "How far the value moves for one click of an arrow.",
	"flowDirection":         "The direction the children are placed in, one after another.",
	"wrapContents":          "Whether the children wrap onto a new line when they run out of room, or keep going.",
	"spacing":               "The gap between neighbouring children, in pixels.",
	"splitterDistance":      "Where the splitter sits, as a fraction of the container from 0 to 1. Drag the splitter on the canvas to set it.",
	"tabAlignment":          "Which side the tabs are drawn on, or hidden for pages switched from code.",
	"tabExtent":             "How wide (or tall, for tabs at the side) the tab strip is.",
	"rowHeight":             "The height of each row, in pixels.",
	"scrollBars":            "Which scroll bars the grid shows when its content does not fit.",
	"columnsMode":           "How the columns share the grid's width: a fixed width each, the width of their content, or filling the grid.",
	"rowsMode":              "Whether rows keep the row height or grow to fit their content.",
	"readOnly":              "Whether the user can edit the cells.",
	"showHeader":            "Whether the column headers are shown.",
	"gridLines":             "Whether lines are drawn between the cells.",
	"frozenColumns":         "How many columns on the left stay in place when the grid scrolls sideways.",
	"frozenRows":            "How many rows at the top stay in place when the grid scrolls down.",
	"dialogTitle":           "The caption of the color dialog the button opens.",
	"interval":              "The time between two Tick events, in milliseconds.",
	"enabledTimer":          "Whether the timer is started when the form is built. The Tick handler is wired before it starts.",
	"title":                 "The caption of the dialog's window.",
	"initialDirectory":      "The folder the dialog opens in.",
	"defaultFileName":       "The file name the dialog suggests.",
	"message":               "The text shown above the colors.",
	"contextMenu":           "The ContextMenu that opens when the control is right-clicked. Add one from the toolbox's Menus & Toolbars group.",
	"dataSource":            "The BindingSource whose records this shows: a row, or an item, per record. Add one from the toolbox's Data group and give it its records in code with SetDataSource.",
	"displayMember":         "The field of each record the list shows. Empty shows the record printed.",
	"allowUserToAddRows":    "Whether an empty row for a new record sits below the others. Typing into it adds a row - on a bound grid, a record, which needs the BindingSource given its slice by pointer: SetDataSource(&list).",
	"allowUserToDeleteRows": "Whether the Delete key removes the selected row (the record, on a bound grid). UserDeletingRow can keep it.",
	"image":                 "The picture shown, copied into the form's folder and embedded in the binary with go:embed, so it travels with the program.",
	"icon":                  "The window's icon, embedded in the binary with go:embed.",
	"fixedSize":             "Whether the user can resize the window.",
	"autoScroll":            "Whether the form scrolls when its controls do not fit in it.",
	"centerOnScreen":        "Whether the window opens in the middle of the screen.",
}

// typeDescriptions overrides propDescriptions where a type's property means
// something of its own.
var typeDescriptions = map[string]map[string]string{
	"Timer": {"enabled": propDescriptions["enabledTimer"]},
}

var eventDescriptions = map[string]string{
	"Click":                "The control was clicked.",
	"DoubleClick":          "The control was double-clicked.",
	"MouseDown":            "A mouse button was pressed over the control.",
	"MouseUp":              "A mouse button was released over the control.",
	"MouseMove":            "The mouse moved over the control.",
	"MouseEnter":           "The mouse came over the control.",
	"MouseLeave":           "The mouse left the control.",
	"MouseWheel":           "The mouse wheel turned over the control.",
	"KeyDown":              "A key was pressed while the control had the focus.",
	"KeyUp":                "A key was released while the control had the focus.",
	"KeyPress":             "A character was typed while the control had the focus.",
	"GotFocus":             "The control received the keyboard focus.",
	"LostFocus":            "The control lost the keyboard focus.",
	"Resize":               "The control's size changed.",
	"Move":                 "The control's position changed.",
	"VisibleChanged":       "The control was shown or hidden.",
	"EnabledChanged":       "The control was enabled or disabled.",
	"TextChanged":          "The text changed, by the user or from code.",
	"CheckedChanged":       "The box was checked or unchecked.",
	"SelectedIndexChanged": "A different item was selected.",
	"ValueChanged":         "The value changed.",
	"Tick":                 "The interval elapsed. Raised again every interval while the timer runs.",
	"Load":                 "The form is about to be shown for the first time.",
	"Shown":                "The form has just been shown for the first time.",
	"Closing":              "The form is about to close. Set e.Cancel to keep it open.",
	"Closed":               "The form has closed.",
	"CellClick":            "A cell was clicked.",
	"SelectionChanged":     "The selected cell changed.",
	"CellValueChanged":     "The user changed a cell's value.",
	"CellButtonClick":      "A button in a button column was clicked.",
	"RowsChanged":          "Rows were added or removed.",
	"ColorChanged":         "A color was picked.",
	"LinkClicked":          "The link was clicked.",
	"NodeSelected":         "A node was selected.",
	"DateChanged":          "A different date was picked.",
	"ItemCheck":            "An item's check box was ticked or cleared.",
	"MaskCompleted":        "Every required position of the mask has been filled in.",
	"SelectedItemChanged":  "A different item was selected.",
	"UserAddedRow":         "The user typed into the row for new records, which made it a row.",
	"UserDeletingRow":      "The user pressed Delete on a row. Set e.Cancel to keep it.",
	"UserDeletedRow":       "The user deleted a row.",
	"PositionChanged":      "The current record changed - a row was selected, or MoveNext was called.",
	"ListChanged":          "The records were replaced, or ResetBindings was called.",
}

// descriptionsFor collects the entries for one type's properties and events,
// keyed by name. Events and properties share the map: no property name
// begins with a capital letter, and no event name does not.
func descriptionsFor(typ string, props []string, events []string) map[string]string {
	out := map[string]string{}
	for _, p := range props {
		if d, ok := typeDescriptions[typ][p]; ok {
			out[p] = d
		} else if d, ok := propDescriptions[p]; ok {
			out[p] = d
		}
	}
	for _, ev := range events {
		if d, ok := eventDescriptions[ev]; ok {
			out[ev] = d
		}
	}
	return out
}
