package main

// ByteRange is a half-open [Start, End) byte offset range within the
// original file, used by the VS Code extension to compute edit positions
// (via TextDocument.positionAt) without this tool needing to know about
// line/column at all.
type ByteRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// CollectionItem is one entry of a control's editable item list: a ToolStrip
// button, a StatusStrip panel, a tab/page title, a tree node. Which of the
// fields carry meaning is decided by the type's CollectionDesc (see
// catalog.go) - a StatusStrip panel is only Text, a ToolStrip button also has
// a Kind and a Handler, a tree node also has a Depth.
type CollectionItem struct {
	Text string `json:"text"`
	// Kind is "separator" for a ToolStrip separator; "" is a normal item.
	Kind string `json:"kind,omitempty"`
	// Handler is the method name wired to this item's click, for the types
	// whose add call takes one (ToolStrip). Empty emits a nil callback.
	Handler string `json:"handler,omitempty"`
	// Depth is the nesting level for tree-shaped collections (TreeView): 0 is
	// a root node, 1 a child of the nearest preceding depth-0 item, and so on.
	// Nesting is expressed as a depth rather than a parent index so the zero
	// value means "root" and a flat list needs no extra bookkeeping.
	Depth int `json:"depth,omitempty"`
}

// GridColumnSpec is one DataGridView column as the designer edits it: the
// header caption plus the three things that are not caption.
//
// The caption lives in the constructor (`NewDataGridView("ID", "Name")`) and
// the rest in indexed setter calls after it, which is why this mirrors Items
// position for position rather than carrying an index of its own - the index
// *is* the position.
type GridColumnSpec struct {
	Title string `json:"title"`
	// Kind is "" for an ordinary text column, or "Button"/"CheckBox". It is
	// the GridColumnKind constant's name without the "GridColumn" prefix,
	// so the generated call reads goforms.GridColumnButton.
	Kind string `json:"kind,omitempty"`
	// Hidden keeps the column's data without drawing it - the id a row was
	// loaded by. See GoForms/datagridview.go.
	Hidden bool `json:"hidden,omitempty"`
	// ButtonText is the fixed caption on a button column's buttons. Empty
	// means each cell's own value is its caption.
	ButtonText string `json:"buttonText,omitempty"`
}

// ControlSpec is one recognized control instance.
type ControlSpec struct {
	ID     string `json:"id"`     // Go field name, e.g. "btnGreet"
	Type   string `json:"type"`   // ControlDesc.Type, e.g. "Button"
	Parent string `json:"parent"` // "" = direct child of the Form; else another ControlSpec.ID
	// ParentSlot names which part of Parent holds this control, for the
	// containers whose halves are reached through an accessor rather than
	// being the container itself: "Panel1"/"Panel2" of a SplitContainer.
	// Empty means the parent takes children directly (Panel, GroupBox).
	ParentSlot string   `json:"parentSlot,omitempty"`
	X          float64  `json:"x"`
	Y          float64  `json:"y"`
	W          float64  `json:"w"`
	H          float64  `json:"h"`
	Text       string   `json:"text,omitempty"`
	Items      []string `json:"items,omitempty"`
	// Rows is ListView's grid data, one []string per row (columns are
	// Items), read from the `<recv>.<field>.AddRow(...)` calls following
	// construction. It exists so the canvas can draw a grid with its real
	// contents; no apply op writes it back, so it is read-only.
	Rows [][]string `json:"rows,omitempty"`
	// Collection is the control's editable item list - ToolStrip buttons,
	// StatusStrip panels, tab/page titles, tree nodes - read from the
	// `<recv>.<field>.Add...(...)` calls following construction and rewritten
	// wholesale by the "setCollection" op. Only types with a CollectionDesc
	// have one.
	Collection []CollectionItem `json:"collection,omitempty"`
	// CollectionReadOnly is set when the file's own add calls contain
	// something this tool can't regenerate (a computed title, a tree node
	// hanging off an unknown variable). Rewriting the list would silently
	// drop that code, so the designer must show the collection but refuse to
	// edit it.
	CollectionReadOnly bool `json:"collectionReadOnly,omitempty"`
	// Columns is a DataGridView's per-column configuration beyond the titles
	// (which are Items, because they are constructor arguments). It is read
	// from the indexed `SetColumnKind`/`SetColumnHidden`/`SetColumnButtonText`
	// calls and rewritten wholesale by the "setColumns" op. Its length always
	// matches Items, so the two can be edited as one table.
	Columns []GridColumnSpec  `json:"columns,omitempty"`
	Props   map[string]string `json:"props,omitempty"`
	// Events maps event name (e.g. "Click") to the handler method name
	// already wired via `<recv>.<field>.<Event>.Handle(<recv>.<method>)`.
	// Empty/absent means not wired yet.
	Events map[string]string `json:"events,omitempty"`
	// Group is the RadioButtonGroup field name this RadioButton belongs to,
	// if any.
	Group string `json:"group,omitempty"`

	// Supported is false when Type isn't in catalog - the control is still
	// reported (so the canvas can show a placeholder box and the file isn't
	// silently corrupted) but the designer must treat it as read-only.
	Supported bool `json:"supported"`

	// Range is this control's whole recognized statement block (from its
	// `New...` assignment through its `AddControl` call), used by apply.go
	// to splice out the block on a "remove" op. Extension code should treat
	// it as opaque.
	Range ByteRange `json:"range"`
}

// RadioGroupSpec records a RadioButtonGroup declaration so it round-trips
// even though it isn't itself a positioned control.
type RadioGroupSpec struct {
	ID      string    `json:"id"`
	Members []string  `json:"members"`
	Range   ByteRange `json:"range"`
}

// FormModel is the full result of `parse` and the refreshed state `apply`
// returns after mutating the file.
type FormModel struct {
	Package      string  `json:"package"`
	ReceiverType string  `json:"receiverType"` // e.g. "MainForm"
	RecvVar      string  `json:"recvVar"`      // e.g. "mf"
	FormTitle    string  `json:"formTitle"`
	FormWidth    float64 `json:"formWidth"`
	FormHeight   float64 `json:"formHeight"`

	Controls    []*ControlSpec    `json:"controls"`
	RadioGroups []*RadioGroupSpec `json:"radioGroups,omitempty"`

	// StructRange is the `type X struct { ... }` body (between braces),
	// where new field declarations are inserted/removed.
	StructRange ByteRange `json:"structRange"`
	// InitRange is the initializeComponent function body (between braces);
	// new control blocks are inserted just before its end.
	InitRange ByteRange `json:"initRange"`

	// Note surfaces anything the tool wants the user to know (e.g. that
	// unrecognized setup code was left untouched).
	Note string `json:"note,omitempty"`
}

// Op is one mutation requested by the extension via `apply`.
type Op struct {
	Op string `json:"op"` // "setBounds" | "setText" | "setItems" | "setCollection" | "setColumns" | "setProp" | "setEvent" | "add" | "remove" | "setParent" | "setForm" | "rename"
	// ID is unused (leave empty) for "setForm", which resizes the Form
	// itself (W/H) rather than a specific control.
	ID     string `json:"id"`
	Type   string `json:"type,omitempty"`   // required for "add"
	Parent string `json:"parent,omitempty"` // for "add"/"setParent": container ID or ""
	// ParentSlot is which part of Parent to add into ("Panel1"/"Panel2"),
	// for containers that expose their halves as accessors.
	ParentSlot string   `json:"parentSlot,omitempty"`
	X          float64  `json:"x,omitempty"`
	Y          float64  `json:"y,omitempty"`
	W          float64  `json:"w,omitempty"`
	H          float64  `json:"h,omitempty"`
	Text       string   `json:"text,omitempty"`
	Items      []string `json:"items,omitempty"`
	// Collection is the complete new item list for "setCollection"; it
	// replaces the control's existing one rather than merging, so a delete is
	// just a shorter list.
	Collection []CollectionItem `json:"collection,omitempty"`
	// Columns is the complete new column list for "setColumns", replacing
	// both the constructor's titles and the indexed setter calls after it.
	Columns []GridColumnSpec `json:"columns,omitempty"`
	Prop    string           `json:"prop,omitempty"`
	// Value is the property value for "setProp", and the *new name* for
	// "rename".
	Value   string `json:"value,omitempty"`
	Event   string `json:"event,omitempty"`
	Handler string `json:"handler,omitempty"`
}
