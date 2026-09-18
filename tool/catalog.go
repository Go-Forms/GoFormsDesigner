package main

import (
	"strconv"
	"strings"
)

// ControlDesc describes one supported control type: how to recognize and
// regenerate it from/to Go source. Adding a new control type to the visual
// designer means adding one entry here - nothing else in this tool is
// type-specific.
type ControlDesc struct {
	// Type is the JSON/UI-facing type name, e.g. "Button".
	Type string
	// Category groups the type in the designer's Controls tab, the way the
	// Visual Studio toolbox groups them. Empty falls back to CategoryCommon.
	Category string `json:",omitempty"`
	// Ctors maps constructor function names (goforms.NewX) that produce this
	// type to a human label for the arg shape, used only for documentation;
	// most types have exactly one, TextBox has three variants.
	Ctors []string
	// DefaultW/DefaultH size a freshly added control from the toolbox.
	DefaultW, DefaultH float64
	// IsContainer marks types whose children are positioned relative to
	// them (Panel, GroupBox) rather than to the Form.
	IsContainer bool
	// NonVisual marks a component that has no place on the canvas: a Timer,
	// a file dialog. It is a field on the form like any other control, but
	// it is never given bounds and never added to a container, so the
	// designer shows it on the tray strip below the form the way Visual
	// Studio does. It also inherits nothing from ControlBase - a Timer has
	// no Anchor and no Click - which is why NonVisual suppresses the base
	// property and event merge rather than just hiding the control.
	NonVisual bool `json:",omitempty"`
	// Fields maps an exported Go struct field to the JSON prop it carries,
	// for the components configured by assignment rather than by a setter
	// call: `mf.dlgOpen.Title = "Open"`. Setters and Fields are the same
	// idea reached through different syntax, and a type may use both.
	Fields map[string]string `json:",omitempty"`
	// Calls maps a bool prop to the no-argument method that turns it on, for
	// the WinForms properties that are a method pair here: a Timer's Enabled
	// is Start()/Stop(), not a field. True emits the call, false emits
	// nothing, which is what "not started" already means.
	Calls map[string]string `json:",omitempty"`
	// CtorProps names the props the constructor itself carries, so there is
	// no setter or field to write them with - setProp replaces the argument
	// in place instead. Declaring them matters twice: the "every kind has a
	// writer" test would otherwise flag them as unwritable, and codegen must
	// not also emit a field assignment for a value the constructor already
	// has.
	CtorProps []string `json:",omitempty"`
	// Slots names the sub-containers a type exposes as accessor methods
	// rather than taking children itself: a SplitContainer has no AddControl
	// of its own, its halves do, so a child is added with
	// `mf.<id>.Panel1().AddControl(mf.<child>)`. A type with Slots takes
	// children only through one of them.
	Slots []string `json:",omitempty"`
	// Setters lists recognized `<recv>.<field>.<Method>(...)` calls and
	// which JSON prop they populate/emit. "text" and "items" are handled
	// specially (see parse.go/apply.go); everything else lands in Props.
	Setters map[string]string
	// Kinds gives the value type of a prop named in Setters: "bool",
	// "number" or "enum". A prop with no entry is a "string". The kind
	// decides how parse.go reads the argument back, how apply.go writes it
	// (bare identifier, bare number, goforms.Qualified or quoted literal),
	// and which editor the webview's property panel shows.
	Kinds map[string]string
	// Enums lists the allowed values of each "enum" prop, written *without*
	// the `goforms.` qualifier that generated code adds back.
	Enums map[string][]string
	// Events lists this type's own semantic event field names, e.g.
	// "TextChanged". The events every control inherits from ControlBase are
	// in baseEvents and are merged in by AllEvents.
	Events []string
	// Imports lists the packages besides goforms this type's constructor
	// needs - "time" for the two controls seeded with time.Now(). "add"
	// brings them with the control, so dropping one from the palette cannot
	// leave a file that does not compile (see imports.go).
	Imports []string `json:",omitempty"`
	// EventArgs gives the Go argument type of a semantic event, without the
	// "goforms." qualifier. Absent means EventArgs.
	EventArgs map[string]string
	// Collection describes this type's editable item list (ToolStrip
	// buttons, tab titles, tree nodes, ...), or nil if it has none. It is
	// what makes parse.go recognize the add calls, apply.go regenerate them
	// and the webview show a list editor - all from this one entry.
	Collection *CollectionDesc `json:",omitempty"`
	// OwnEventCount is set only on the catalog command's output: how many
	// of the merged Events list belong to this type rather than being
	// inherited from ControlBase. The Events panel uses it to draw the
	// divider, so it never has to hardcode how many base events exist.
	OwnEventCount int `json:",omitempty"`
}

// CollectionDesc describes one control type's editable item list: the call
// that appends an item, and which of CollectionItem's fields that call
// actually carries. Everything else about collections - parsing, rewriting,
// the property-panel editor - is driven from this, so adding a collection to
// a new control type means one entry here plus its render in designer.js.
type CollectionDesc struct {
	// Label names the items in the UI, e.g. "Buttons" or "Tabs".
	Label string
	// Method is the item-adding call, e.g. "AddButton".
	Method string
	// Handler marks a Method whose last argument is a `func()` callback, so
	// items carry a click handler (ToolStrip). The generated call passes nil
	// when an item has none.
	Handler bool
	// Separator marks a type that also understands AddSeparator(), giving
	// items a "separator" Kind.
	Separator bool
	// Tree marks a Method shaped `Add(parent, text)` whose items nest, so
	// CollectionItem.Depth is meaningful (TreeView).
	Tree bool
	// ItemSlot marks a collection whose items are themselves containers -
	// tab pages - and names the ParentSlot stem they get: "Page" yields
	// "Page1", "Page2", ... in collection order. Empty means the items are
	// just labels (buttons, panels, tree nodes).
	ItemSlot string
	// ItemsAccessor is the method returning every item as a slice, so a
	// control on the second page is added with
	// `mf.<id>.<ItemsAccessor>()[1].AddControl(...)`.
	//
	// Addressing a page by index rather than by binding the add call's
	// return to a local variable is what keeps the item list and the
	// controls on it independent: rewriting the list never leaves a dangling
	// variable reference behind, and an empty page never leaves an unused
	// variable that wouldn't compile.
	ItemsAccessor string
	// Default seeds a freshly added control, so dropping a TabControl from
	// the toolbox produces something with visible tabs rather than an empty
	// box that reads as a broken drop - the same reasoning as DataGridView's
	// seeded columns in codegen.go.
	Default []CollectionItem
}

// baseEvents are the interaction events ControlBase gives every control
// (see GoForms/interaction.go), mapped to their argument type. Generated
// handler stubs must use the right type or they won't compile, which is why
// this table exists rather than defaulting everything to EventArgs.
var baseEvents = map[string]string{
	"Click":          "MouseEventArgs",
	"DoubleClick":    "MouseEventArgs",
	"MouseDown":      "MouseEventArgs",
	"MouseUp":        "MouseEventArgs",
	"MouseMove":      "MouseEventArgs",
	"MouseEnter":     "EventArgs",
	"MouseLeave":     "EventArgs",
	"MouseWheel":     "MouseEventArgs",
	"KeyDown":        "KeyEventArgs",
	"KeyUp":          "KeyEventArgs",
	"KeyPress":       "KeyPressEventArgs",
	"GotFocus":       "EventArgs",
	"LostFocus":      "EventArgs",
	"Resize":         "EventArgs",
	"Move":           "EventArgs",
	"VisibleChanged": "EventArgs",
	"EnabledChanged": "EventArgs",
}

// baseEventOrder keeps the property panel's event list stable and grouped
// the way a WinForms developer expects, rather than alphabetical.
var baseEventOrder = []string{
	"Click", "DoubleClick",
	"MouseDown", "MouseUp", "MouseMove", "MouseEnter", "MouseLeave", "MouseWheel",
	"KeyDown", "KeyUp", "KeyPress",
	"GotFocus", "LostFocus",
	"Resize", "Move", "VisibleChanged", "EnabledChanged",
}

// eventArgType reports the Go argument type for an event on this control,
// checking the type's own events first and then the inherited ones.
func eventArgType(desc *ControlDesc, event string) (string, bool) {
	if desc != nil {
		if t, ok := desc.EventArgs[event]; ok {
			return t, true
		}
		for _, e := range desc.Events {
			if e == event {
				return "EventArgs", true
			}
		}
		if desc.NonVisual {
			// A Timer is not a ControlBase and has no Click to wire; saying
			// it does would generate a stub that does not compile.
			return "", false
		}
	}
	if t, ok := baseEvents[event]; ok {
		return t, true
	}
	return "", false
}

// allEventsFor lists a control's own events followed by the inherited ones,
// which is the order the designer's Events panel shows them in.
func allEventsFor(desc *ControlDesc) []string {
	var out []string
	if desc != nil {
		out = append(out, desc.Events...)
		if desc.NonVisual {
			return out
		}
	}
	return append(out, baseEventOrder...)
}

// Toolbox categories, mirroring the groups the Visual Studio designer's
// toolbox uses. categoryOrder is the order they are shown in.
const (
	CategoryCommon     = "Common Controls"
	CategoryContainers = "Containers"
	CategoryMenus      = "Menus & Toolbars"
	CategoryData       = "Data"
	// CategoryComponents holds the types with no appearance - a Timer, the
	// dialogs. They land on the tray below the form rather than on it.
	CategoryComponents = "Components"
)

var categoryOrder = []string{CategoryCommon, CategoryContainers, CategoryMenus, CategoryData, CategoryComponents}

// PropKind names the value types Kinds may use.
const (
	KindString = "string"
	KindBool   = "bool"
	KindNumber = "number"
	KindEnum   = "enum"
	// KindFlags is a set of OR-ed constants, e.g. Anchor. The wire value is
	// a comma-separated list of names from Enums; the generated code joins
	// them with "|".
	KindFlags = "flags"
)

// baseProps are the properties every control inherits from ControlBase (see
// GoForms/control.go). They are merged into each type's own Setters by the
// catalog command, the same way baseEvents are.
var baseProps = map[string]string{
	"SetAnchor":   "anchor",
	"SetDock":     "dock",
	"SetTabIndex": "tabIndex",
	"SetTabStop":  "tabStop",
}

var basePropKinds = map[string]string{
	"anchor":   KindFlags,
	"dock":     KindEnum,
	"tabIndex": KindNumber,
	"tabStop":  KindBool,
}

var basePropEnums = map[string][]string{
	"anchor": {"AnchorTop", "AnchorBottom", "AnchorLeft", "AnchorRight"},
	"dock":   {"DockNone", "DockTop", "DockBottom", "DockLeft", "DockRight", "DockFill"},
}

// kindOf reports the value type of a prop, defaulting to KindString.
func kindOf(desc *ControlDesc, prop string) string {
	if desc != nil && desc.Kinds != nil {
		if k, ok := desc.Kinds[prop]; ok {
			return k
		}
	}
	if k, ok := basePropKinds[prop]; ok {
		return k
	}
	return KindString
}

// enumsFor returns the allowed values of an enum/flags prop, falling back to
// the inherited table.
func enumsFor(desc *ControlDesc, prop string) []string {
	if desc != nil && desc.Enums != nil {
		if v, ok := desc.Enums[prop]; ok {
			return v
		}
	}
	return basePropEnums[prop]
}

// setterForProp is the reverse of ControlDesc.Setters: which method writes
// this prop. apply.go needs it to synthesize a setter call for a prop that
// has no call in the file yet.
func setterForProp(desc *ControlDesc, prop string) (method string, ok bool) {
	if desc != nil {
		for m, p := range desc.Setters {
			if p == prop {
				return m, true
			}
		}
		if desc.NonVisual {
			return "", false
		}
	}
	for m, p := range baseProps {
		if p == prop {
			return m, true
		}
	}
	return "", false
}

// fieldForProp is setterForProp's counterpart for the components configured
// by assignment: which exported field carries this prop.
func fieldForProp(desc *ControlDesc, prop string) (field string, ok bool) {
	if desc == nil {
		return "", false
	}
	for f, p := range desc.Fields {
		if p == prop {
			return f, true
		}
	}
	return "", false
}

// callForProp reports the no-argument method a bool prop turns into, e.g. a
// Timer's enabled -> Start.
func callForProp(desc *ControlDesc, prop string) (method string, ok bool) {
	if desc == nil {
		return "", false
	}
	method, ok = desc.Calls[prop]
	return
}

// isCtorProp reports whether the constructor is where this prop lives.
func isCtorProp(desc *ControlDesc, prop string) bool {
	if desc == nil {
		return false
	}
	for _, p := range desc.CtorProps {
		if p == prop {
			return true
		}
	}
	return false
}

// writerForProp reports whether a prop can be written back at all, and how.
// Every prop the designer offers must have exactly one answer here; a prop
// with none would show an editor that silently does nothing.
func writerForProp(desc *ControlDesc, prop string) (how string, ok bool) {
	if _, ok := setterForProp(desc, prop); ok {
		return "setter", true
	}
	if _, ok := fieldForProp(desc, prop); ok {
		return "field", true
	}
	if _, ok := callForProp(desc, prop); ok {
		return "call", true
	}
	if isCtorProp(desc, prop) {
		return "constructor argument", true
	}
	return "", false
}

// isNonVisual reports whether a type belongs on the tray rather than the
// canvas. It takes the type name because most callers have only that.
func isNonVisual(typ string) bool {
	desc, ok := catalog[typ]
	return ok && desc.NonVisual
}

// catalog is keyed by ControlDesc.Type.
var catalog = map[string]*ControlDesc{
	"Label": {
		Type: "Label", Ctors: []string{"NewLabel"}, DefaultW: 120, DefaultH: 24,
		Setters: map[string]string{"SetText": "text"},
	},
	"Button": {
		Type: "Button", Ctors: []string{"NewButton"}, DefaultW: 90, DefaultH: 30,
		Setters: map[string]string{"SetText": "text"},
		// No Events of its own: Click comes from ControlBase like every
		// other control's, carrying MouseEventArgs (see baseEvents).
	},
	"TextBox": {
		Type: "TextBox", Ctors: []string{"NewTextBox", "NewMultilineTextBox", "NewPasswordTextBox"},
		DefaultW: 160, DefaultH: 30,
		Setters: map[string]string{"SetText": "text", "SetPlaceholder": "placeholder"},
		Events:  []string{"TextChanged"},
	},
	"CheckBox": {
		Type: "CheckBox", Ctors: []string{"NewCheckBox"}, DefaultW: 160, DefaultH: 24,
		Setters: map[string]string{"SetText": "text", "SetChecked": "checked"},
		Events:  []string{"CheckedChanged"},
	},
	"RadioButton": {
		Type: "RadioButton", Ctors: []string{"NewRadioButton"}, DefaultW: 90, DefaultH: 24,
		Setters: map[string]string{"SetText": "text", "SetChecked": "checked"},
		Events:  []string{"CheckedChanged"},
	},
	"ComboBox": {
		Type: "ComboBox", Ctors: []string{"NewComboBox"}, DefaultW: 150, DefaultH: 30,
		Setters: map[string]string{"SetPlaceholder": "placeholder"},
		Events:  []string{"SelectedIndexChanged"},
	},
	"ListBox": {
		Type: "ListBox", Ctors: []string{"NewListBox"}, DefaultW: 150, DefaultH: 120,
		Events: []string{"SelectedIndexChanged"},
	},
	"Panel": {
		Type: "Panel", Ctors: []string{"NewPanel"}, DefaultW: 200, DefaultH: 150,
		IsContainer: true,
	},
	"GroupBox": {
		Type: "GroupBox", Ctors: []string{"NewGroupBox"}, DefaultW: 200, DefaultH: 150,
		IsContainer: true,
		Setters:     map[string]string{"SetText": "text"},
	},
	"PictureBox": {
		Type: "PictureBox", Ctors: []string{"NewPictureBox"}, DefaultW: 100, DefaultH: 100,
	},
	"ProgressBar": {
		Type: "ProgressBar", Ctors: []string{"NewProgressBar"}, DefaultW: 150, DefaultH: 20,
	},
	"TrackBar": {
		Type: "TrackBar", Ctors: []string{"NewTrackBar"}, DefaultW: 150, DefaultH: 30,
		Events: []string{"ValueChanged"},
	},
	"NumericUpDown": {
		Type: "NumericUpDown", Ctors: []string{"NewNumericUpDown"}, DefaultW: 90, DefaultH: 26,
		Events: []string{"ValueChanged"},
	},
	"DateTimePicker": {
		Type: "DateTimePicker", Ctors: []string{"NewDateTimePicker"}, DefaultW: 150, DefaultH: 30,
		Events:  []string{"ValueChanged"},
		Imports: []string{"time"},
	},
	"LinkLabel": {
		Type: "LinkLabel", Ctors: []string{"NewLinkLabel", "NewLinkLabelWithURL"}, DefaultW: 100, DefaultH: 24,
		Setters: map[string]string{"SetText": "text"},
		Events:  []string{"LinkClicked"},
	},
	"ListView": {
		Type: "ListView", Ctors: []string{"NewListView"}, DefaultW: 300, DefaultH: 150,
		Events: []string{"SelectedIndexChanged"},
	},
	"TreeView": {
		Type: "TreeView", Ctors: []string{"NewTreeView"}, DefaultW: 200, DefaultH: 200,
		Events: []string{"NodeSelected"},
		Collection: &CollectionDesc{
			Label: "Nodes", Method: "AddNode", Tree: true,
			Default: []CollectionItem{
				{Text: "Node 1"},
				{Text: "Child A", Depth: 1},
				{Text: "Node 2"},
			},
		},
	},
	"TabControl": {
		Type: "TabControl", Ctors: []string{"NewTabControl"}, DefaultW: 400, DefaultH: 300,
		Events: []string{"SelectedIndexChanged"},
		Collection: &CollectionDesc{
			Label: "Tabs", Method: "AddTab", ItemSlot: "Tab", ItemsAccessor: "TabPages",
			Default: []CollectionItem{{Text: "Tab 1"}, {Text: "Tab 2"}},
		},
	},
	"ToolStrip": {
		Type: "ToolStrip", Ctors: []string{"NewToolStrip"}, DefaultW: 400, DefaultH: 34,
		Collection: &CollectionDesc{
			Label: "Buttons", Method: "AddButton", Handler: true, Separator: true,
			Default: []CollectionItem{{Text: "New"}, {Text: "Open"}},
		},
	},
	"StatusStrip": {
		Type: "StatusStrip", Ctors: []string{"NewStatusStrip"}, DefaultW: 400, DefaultH: 24,
		Collection: &CollectionDesc{
			Label: "Panels", Method: "AddPanel",
			Default: []CollectionItem{{Text: "Ready"}},
		},
	},
	"Splitter": {
		Type: "Splitter", Ctors: []string{"NewHorizontalSplitter", "NewVerticalSplitter"}, DefaultW: 400, DefaultH: 300,
	},
	"ScrollBox": {
		Type: "ScrollBox", Ctors: []string{"NewScrollBox"}, DefaultW: 250, DefaultH: 200,
		IsContainer: true,
	},
	"MaskedTextBox": {
		Type: "MaskedTextBox", Ctors: []string{"NewMaskedTextBox"}, DefaultW: 160, DefaultH: 30,
		Setters: map[string]string{"SetText": "text", "SetPlaceholder": "placeholder", "SetMask": "mask"},
		Events:  []string{"TextChanged", "MaskCompleted"},
	},
	"RichTextBox": {
		Type: "RichTextBox", Ctors: []string{"NewRichTextBox"}, DefaultW: 300, DefaultH: 150,
		Setters: map[string]string{"SetText": "text", "SetWordWrap": "wordWrap"},
		Kinds:   map[string]string{"wordWrap": KindBool},
	},
	"CheckedListBox": {
		Type: "CheckedListBox", Ctors: []string{"NewCheckedListBox"}, DefaultW: 180, DefaultH: 140,
		Events: []string{"ItemCheck"},
	},
	"MonthCalendar": {
		// 271 high, not 240: a month grid needs 270.5 and Fyne draws a
		// calendar clipped rather than scrolled, so anything shorter puts the
		// last row of days outside the control where it cannot be clicked.
		// The control refuses to be smaller than this anyway (GoForms
		// inputcontrols.go), so a smaller default would only ever disagree
		// with what the running form shows.
		Type: "MonthCalendar", Ctors: []string{"NewMonthCalendar"}, DefaultW: 260, DefaultH: 271,
		Events:  []string{"DateChanged"},
		Imports: []string{"time"},
	},
	"DomainUpDown": {
		Type: "DomainUpDown", Ctors: []string{"NewDomainUpDown"}, DefaultW: 160, DefaultH: 48,
		Events: []string{"SelectedItemChanged"},
	},
	"ScrollBar": {
		Type: "ScrollBar", Ctors: []string{"NewHScrollBar", "NewVScrollBar"}, DefaultW: 150, DefaultH: 20,
		Setters: map[string]string{"SetSmallChange": "smallChange"},
		Kinds:   map[string]string{"smallChange": KindNumber},
		Events:  []string{"ValueChanged"},
	},
	"FlowLayoutPanel": {
		Type: "FlowLayoutPanel", Ctors: []string{"NewFlowLayoutPanel"}, DefaultW: 250, DefaultH: 200,
		IsContainer: true,
		Setters: map[string]string{
			"SetFlowDirection": "flowDirection",
			"SetWrapContents":  "wrapContents",
			"SetSpacing":       "spacing",
		},
		Kinds: map[string]string{
			"flowDirection": KindEnum,
			"wrapContents":  KindBool,
			"spacing":       KindNumber,
		},
		Enums: map[string][]string{
			"flowDirection": {"FlowLeftToRight", "FlowTopDown", "FlowRightToLeft", "FlowBottomUp"},
		},
	},
	"TableLayoutPanel": {
		Type: "TableLayoutPanel", Ctors: []string{"NewTableLayoutPanel"}, DefaultW: 300, DefaultH: 200,
		IsContainer: true,
	},
	"SplitContainer": {
		Type: "SplitContainer", Ctors: []string{"NewSplitContainer"}, DefaultW: 400, DefaultH: 250,
		// Deliberately not IsContainer: SplitContainer itself has no
		// AddControl, so a child must name one of the halves.
		Slots:   []string{"Panel1", "Panel2"},
		Setters: map[string]string{"SetSplitterDistance": "splitterDistance"},
		Kinds:   map[string]string{"splitterDistance": KindNumber},
	},
	"ViewContainer": {
		Type: "ViewContainer", Ctors: []string{"NewViewContainer"}, DefaultW: 400, DefaultH: 300,
		// Deliberately not IsContainer: like TabControl, ViewContainer has no
		// AddControl of its own - controls live on a page, which AddPage
		// returns. Marking it a plain container generated
		// `mf.views.AddControl(...)`, which does not compile.
		Setters: map[string]string{
			"SetTabAlignment": "tabAlignment",
			"SetTabExtent":    "tabExtent",
		},
		Kinds: map[string]string{"tabAlignment": KindEnum, "tabExtent": KindNumber},
		Enums: map[string][]string{
			"tabAlignment": {"TabsTop", "TabsBottom", "TabsLeft", "TabsRight", "TabsHidden"},
		},
		Events: []string{"SelectedIndexChanged"},
		Collection: &CollectionDesc{
			Label: "Pages", Method: "AddPage", ItemSlot: "Page", ItemsAccessor: "Pages",
			Default: []CollectionItem{{Text: "Page 1"}, {Text: "Page 2"}},
		},
	},
	"DataGridView": {
		Type: "DataGridView", Ctors: []string{"NewDataGridView"}, DefaultW: 400, DefaultH: 200,
		Setters: map[string]string{
			"SetRowHeight":           "rowHeight",
			"SetScrollBars":          "scrollBars",
			"SetAutoSizeColumnsMode": "columnsMode",
			"SetAutoSizeRowsMode":    "rowsMode",
			"SetReadOnly":            "readOnly",
			"SetShowHeader":          "showHeader",
			"SetGridLines":           "gridLines",
			"SetFrozenColumns":       "frozenColumns",
			"SetFrozenRows":          "frozenRows",
		},
		Kinds: map[string]string{
			"rowHeight":     KindNumber,
			"scrollBars":    KindEnum,
			"columnsMode":   KindEnum,
			"rowsMode":      KindEnum,
			"readOnly":      KindBool,
			"showHeader":    KindBool,
			"gridLines":     KindBool,
			"frozenColumns": KindNumber,
			"frozenRows":    KindNumber,
		},
		Enums: map[string][]string{
			"scrollBars":  {"ScrollBarsNone", "ScrollBarsHorizontal", "ScrollBarsVertical", "ScrollBarsBoth"},
			"columnsMode": {"SizeFixed", "SizeToContent", "SizeFill"},
			"rowsMode":    {"SizeFixed", "SizeToContent"},
		},
		Events: []string{"CellClick", "SelectionChanged", "CellValueChanged", "CellButtonClick", "RowsChanged"},
		// Four of the five carry a cell, not a bare EventArgs. Getting this
		// wrong is not cosmetic: ensure-handler writes the stub's parameter
		// from here, and a stub with the wrong type does not satisfy
		// Event.Handle, so wiring the event stops the project compiling.
		EventArgs: map[string]string{
			"CellClick":        "GridCellEventArgs",
			"SelectionChanged": "GridCellEventArgs",
			"CellButtonClick":  "GridCellEventArgs",
			"CellValueChanged": "GridCellValueEventArgs",
		},
	},
	"ColorPickerButton": {
		Type: "ColorPickerButton", Ctors: []string{"NewColorPickerButton"}, DefaultW: 110, DefaultH: 30,
		Setters: map[string]string{"SetDialogTitle": "dialogTitle"},
		Events:  []string{"ColorChanged"},
	},

	// The tray. These have no bounds and are never added to a container;
	// everything about them is the constructor, a few field assignments and,
	// for the Timer, an event.
	"Timer": {
		Type: "Timer", Ctors: []string{"NewTimer"}, NonVisual: true,
		// Interval is both a constructor argument and an exported field.
		// Writing it twice with the same value is how the two come to
		// disagree, so the constructor is the single place it lives.
		CtorProps: []string{"interval"},
		Kinds:     map[string]string{"interval": KindNumber, "enabled": KindBool},
		Calls:     map[string]string{"enabled": "Start"},
		Events:    []string{"Tick"},
	},
	"OpenFileDialog": {
		Type: "OpenFileDialog", Ctors: []string{"NewOpenFileDialog"}, NonVisual: true,
		Fields: map[string]string{"Title": "title", "InitialDirectory": "initialDirectory"},
	},
	"SaveFileDialog": {
		Type: "SaveFileDialog", Ctors: []string{"NewSaveFileDialog"}, NonVisual: true,
		Fields: map[string]string{
			"Title": "title", "InitialDirectory": "initialDirectory",
			"DefaultFileName": "defaultFileName",
		},
	},
	"FolderBrowserDialog": {
		Type: "FolderBrowserDialog", Ctors: []string{"NewFolderBrowserDialog"}, NonVisual: true,
		Fields: map[string]string{"Title": "title", "InitialDirectory": "initialDirectory"},
	},
	"ColorDialog": {
		Type: "ColorDialog", Ctors: []string{"NewColorDialog"}, NonVisual: true,
		Fields: map[string]string{"Title": "title", "Message": "message"},
	},
}

// Filter is deliberately absent from the dialog entries above: it is a
// FileDialogFilter struct, not a scalar, and a property grid that could only
// write half of it would be worse than one that leaves the whole thing to
// hand-written code - which the tidy pass does not touch.

// controlCategory names the toolbox group of every type that isn't a plain
// control. Keeping only the exceptions here - rather than a Category on all
// thirty-odd catalog entries - means a newly added control lands in Common
// Controls by default, which is where most of them belong.
var controlCategory = map[string]string{
	"Panel":            CategoryContainers,
	"GroupBox":         CategoryContainers,
	"TabControl":       CategoryContainers,
	"ViewContainer":    CategoryContainers,
	"SplitContainer":   CategoryContainers,
	"Splitter":         CategoryContainers,
	"ScrollBox":        CategoryContainers,
	"FlowLayoutPanel":  CategoryContainers,
	"TableLayoutPanel": CategoryContainers,

	"ToolStrip":   CategoryMenus,
	"StatusStrip": CategoryMenus,

	"DataGridView": CategoryData,
	"ListView":     CategoryData,
	"TreeView":     CategoryData,

	"Timer":               CategoryComponents,
	"OpenFileDialog":      CategoryComponents,
	"SaveFileDialog":      CategoryComponents,
	"FolderBrowserDialog": CategoryComponents,
	"ColorDialog":         CategoryComponents,
}

// init fills in each type's Category so the catalog command has it without
// every entry above having to repeat the common case.
func init() {
	for typ, desc := range catalog {
		if c, ok := controlCategory[typ]; ok {
			desc.Category = c
			continue
		}
		desc.Category = CategoryCommon
	}
}

// ctorToType maps every constructor function name back to its ControlDesc,
// built once from catalog so parse.go can do an O(1) lookup per call expr.
var ctorToType = func() map[string]*ControlDesc {
	m := map[string]*ControlDesc{}
	for _, d := range catalog {
		for _, c := range d.Ctors {
			m[c] = d
		}
	}
	return m
}()

// hasSlot reports whether a type exposes the named fixed sub-container.
// Page slots are per-instance (there are as many as the control has pages),
// so they are not covered here - see slotsOf.
func hasSlot(typ, slot string) bool {
	desc, ok := catalog[typ]
	if !ok {
		return false
	}
	for _, s := range desc.Slots {
		if s == slot {
			return true
		}
	}
	return false
}

// slotsOf lists the places one particular control can hold children: its
// type's fixed slots (SplitContainer's halves), or one per collection item
// for the types whose items are pages (TabControl, ViewContainer). A tab
// control with no tabs holds nothing, which is why this takes an instance
// rather than just a type name.
func slotsOf(spec *ControlSpec) []string {
	desc, ok := catalog[spec.Type]
	if !ok {
		return nil
	}
	if len(desc.Slots) > 0 {
		return desc.Slots
	}
	if desc.Collection != nil && desc.Collection.ItemSlot != "" {
		out := make([]string, len(spec.Collection))
		for i := range spec.Collection {
			out[i] = pageSlotName(desc.Collection.ItemSlot, i)
		}
		return out
	}
	return nil
}

// pageSlotName is the ParentSlot of the i'th (0-based) item of a page
// collection: "Page1", "Tab2", ...
func pageSlotName(prefix string, i int) string {
	return prefix + strconv.Itoa(i+1)
}

// pageSlotIndex is pageSlotName's inverse: the 0-based item index a page slot
// names, or -1 if the name isn't one of this type's page slots.
func pageSlotIndex(typ, slot string) int {
	desc, ok := catalog[typ]
	if !ok || desc.Collection == nil || desc.Collection.ItemSlot == "" {
		return -1
	}
	rest, found := strings.CutPrefix(slot, desc.Collection.ItemSlot)
	if !found {
		return -1
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n < 1 {
		return -1
	}
	return n - 1
}

// takesChildrenThroughSlots reports whether a type holds children only via
// slots (fixed or per-page) rather than directly.
func takesChildrenThroughSlots(typ string) bool {
	desc, ok := catalog[typ]
	if !ok {
		return false
	}
	return len(desc.Slots) > 0 || (desc.Collection != nil && desc.Collection.ItemSlot != "")
}

// acceptsChildren reports whether a control can be a parent at all - either
// directly (Panel, GroupBox) or through a slot (SplitContainer, TabControl).
func acceptsChildren(typ string) bool {
	desc, ok := catalog[typ]
	return ok && (desc.IsContainer || takesChildrenThroughSlots(typ))
}

// collectionFor returns a control type's collection description, or nil for
// the types (most of them) that have no editable item list.
func collectionFor(typ string) *CollectionDesc {
	if desc, ok := catalog[typ]; ok {
		return desc.Collection
	}
	return nil
}

// setterProp is a flattened view of every ControlDesc.Setters, used by
// parse.go to recognize a `<recv>.<field>.<Method>(...)` call without first
// knowing the field's type.
//
// The inherited ControlBase setters (SetDock, SetAnchor, SetTabIndex,
// SetTabStop) are folded in here rather than only by the `catalog` command,
// because parse must recognize them for three separate things to work: the
// property panel reads their current values, setProp replaces an existing
// argument instead of appending a second call, and the canvas needs to know
// a control is docked to draw it against its parent's edge rather than at
// its stored bounds.
func setterProp(desc *ControlDesc, method string) (prop string, ok bool) {
	if desc != nil {
		if prop, ok = desc.Setters[method]; ok {
			return prop, true
		}
		if desc.NonVisual {
			// Start() on a Timer reads back as enabled=true; there is no
			// ControlBase setter to fall through to.
			for p, m := range desc.Calls {
				if m == method {
					return p, true
				}
			}
			return "", false
		}
	}
	prop, ok = baseProps[method]
	return
}

// fieldProp is setterProp for assignment-configured components: which prop a
// `<recv>.<field>.<Name> = ...` statement writes.
func fieldProp(desc *ControlDesc, field string) (prop string, ok bool) {
	if desc == nil {
		return "", false
	}
	prop, ok = desc.Fields[field]
	return
}

// flagsZeroValue names the "nothing set" constant of a flags family:
// AnchorTop/AnchorLeft/... share the prefix "Anchor", whose zero value is
// AnchorNone. Deriving it beats another table to keep in sync.
func flagsZeroValue(allowed []string) string {
	if len(allowed) == 0 {
		return ""
	}
	prefix := allowed[0]
	for _, a := range allowed[1:] {
		for prefix != "" && !strings.HasPrefix(a, prefix) {
			prefix = prefix[:len(prefix)-1]
		}
	}
	return prefix + "None"
}
