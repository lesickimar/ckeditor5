/**
 * @license Copyright (c) 2003-2021, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module source-editing/sourceediting
 */

import { Plugin, PendingActions } from 'ckeditor5/src/core';
import { ButtonView } from 'ckeditor5/src/ui';
import { createElement, ElementReplacer } from 'ckeditor5/src/utils';

import '../theme/sourceediting.css';

// TODO: create icon
// import sourceEditingIcon from '../theme/icons/sourceediting.svg';

const COMMAND_FORCE_DISABLE_ID = 'SourceEditingMode';

/**
 * The source editing feature.
 *
 * It provides the possibility to view and edit the source of the document.
 *
 * For a detailed overview, check the {@glink features/source-editing source editing feature documentation} and the
 * {@glink api/source-editing package page}.
 *
 * @extends module:core/plugin~Plugin
 */
export default class SourceEditing extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'SourceEditing';
	}

	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ PendingActions ];
	}

	/**
	 * @inheritDoc
	 */
	constructor( editor ) {
		super( editor );

		/**
		 * Flag indicating whether the document source mode is active.
		 *
		 * @observable
		 * @member {Boolean}
		 */
		this.set( 'isSourceEditingMode', false );

		/**
		 * The element replacer instance used to replace the editing roots with the wrapper elements containing the document source.
		 *
		 * @private
		 * @member {module:utils/elementreplacer~ElementReplacer}
		 */
		this._elementReplacer = new ElementReplacer();

		/**
		 * Maps all root names to wrapper elements containing the document source.
		 *
		 * @private
		 * @member {Map.<String,HTMLElement>}
		 */
		this._replacedRoots = new Map();
	}

	/**
	 * @inheritDoc
	 */
	init() {
		const editor = this.editor;
		const t = editor.t;

		editor.ui.componentFactory.add( 'sourceEditing', locale => {
			const buttonView = new ButtonView( locale );

			buttonView.set( {
				label: t( 'Edit source' ),
				// TODO: use icon
				// icon: sourceEditingIcon,
				tooltip: true,
				withText: true
			} );

			buttonView.bind( 'isOn' ).to( this, 'isSourceEditingMode' );

			// Disable button if:
			// - plugin is disabled, or
			// - editor is in a read-only mode, or
			// - there is a pending action.
			//
			// Pending action may change the model, so viewing and/or editing the document source should be prevented until the model is
			// finally set.
			buttonView.bind( 'isEnabled' ).to(
				this, 'isEnabled',
				editor, 'isReadOnly',
				editor.plugins.get( PendingActions ), 'hasAny',
				( isEnabled, isEditorReadOnly, hasAnyPendingActions ) => isEnabled && !isEditorReadOnly && !hasAnyPendingActions
			);

			this.listenTo( buttonView, 'execute', () => {
				this.isSourceEditingMode = !this.isSourceEditingMode;

				/**
				 * Fired whenever the source editing mode is toggled.
				 *
				 * @event sourceEditing
				 * @param {Object} data Additional information about the event.
				 * @param {Boolean} data.isSourceEditingMode Flag indicating whether the document source mode is active.
				 */
				this.fire( 'sourceEditing', { isSourceEditingMode: this.isSourceEditingMode } );
			} );

			return buttonView;
		} );

		// Currently, plugin handles the source editing mode by itself only for the Classic Editor. To use this plugin with other
		// integrations, listen to `sourceEditing` event and act accordingly.
		if ( this._isAllowedToHandleSourceEditingMode() ) {
			this.on( 'sourceEditing', ( evt, { isSourceEditingMode } ) => {
				if ( isSourceEditingMode ) {
					this._showSourceEditing();
					this._disableCommands();
				} else {
					this._hideSourceEditing();
					this._enableCommands();
				}
			} );

			this.on( 'change:isEnabled', ( evt, name, isEnabled ) => this._handleReadOnlyMode( !isEnabled ) );

			this.listenTo( editor, 'change:isReadOnly', ( evt, name, isReadOnly ) => this._handleReadOnlyMode( isReadOnly ) );
		}
	}

	/**
	 * Creates source editing wrappers, that replace each editing root. Each wrapper contains the document source from corresponding root.
	 *
	 * The wrapper element contains a textarea and it solves the problem, that the textarea element cannot auto expand its height based on
	 * the content it contains. The solution is to make the textarea more like a plain div element, which expands in height as much as it
	 * needs to, in order to display the whole document source without scrolling. The wrapper element is a parent for the textarea and for
	 * the pseudo-element `::after`, that replicates the look, content, and position of the textarea. The pseudo-element replica is hidden,
	 * but it is styled to be an identical visual copy of the textarea with the same content. Then, the wrapper is a grid container and both
	 * of its children (the textarea and the `::after` pseudo-element) are positioned within a CSS grid to occupy the same grid cell. The
	 * content in the pseudo-element `::after` is set in CSS and it stretches the grid to the appropriate size based on the textarea value.
	 * Since both children occupy the same grid cell, both have always the same height.
	 *
	 * @private
	 */
	_showSourceEditing() {
		const editor = this.editor;
		const editingView = editor.editing.view;
		const model = editor.model;

		model.change( writer => {
			writer.setSelection( null );
			writer.removeSelectionAttribute( model.document.selection.getAttributeKeys() );
		} );

		// It is not needed to iterate through all editing roots, as currently the plugin supports only the Classic Editor with single
		// main root, but this code may help understand and use this feature in external integrations.
		for ( const [ rootName, domRootElement ] of editingView.domRoots ) {
			const data = editor.data.get( { rootName } );

			const domSourceEditingElementTextarea = createElement( domRootElement.ownerDocument, 'textarea', { rows: '1' } );

			const domSourceEditingElementWrapper = createElement( domRootElement.ownerDocument, 'div', {
				class: 'source-editing',
				'data-value': data
			}, [ domSourceEditingElementTextarea ] );

			domSourceEditingElementTextarea.value = data;

			// Bind the textarea's value to the wrapper's `data-value` property. Each change of the textarea's value updates the
			// wrapper's `data-value` property.
			domSourceEditingElementTextarea.addEventListener( 'input', () => {
				domSourceEditingElementWrapper.dataset.value = domSourceEditingElementTextarea.value;
			} );

			editingView.change( writer => {
				const viewRoot = editingView.document.getRoot( rootName );

				writer.addClass( 'ck-hidden', viewRoot );
			} );

			this._replacedRoots.set( rootName, domSourceEditingElementWrapper );

			this._elementReplacer.replace( domRootElement, domSourceEditingElementWrapper );
		}

		this._focusSourceEditing();
	}

	/**
	 * Restores all hidden editing roots and sets the source data in them.
	 *
	 * @private
	 */
	_hideSourceEditing() {
		const editor = this.editor;
		const editingView = editor.editing.view;

		for ( const [ rootName, domSourceEditingElementWrapper ] of this._replacedRoots ) {
			const oldData = editor.data.get( rootName );
			const newData = domSourceEditingElementWrapper.dataset.value;

			// Do not set the data unless some changes has been made.
			// This prevents empty undo steps after switching to the normal editor.
			if ( oldData !== newData ) {
				editor.data.set( { [ rootName ]: domSourceEditingElementWrapper.dataset.value }, { supportUndo: true } );
			}

			editingView.change( writer => {
				const viewRoot = editingView.document.getRoot( rootName );

				writer.removeClass( 'ck-hidden', viewRoot );
			} );
		}

		this._elementReplacer.restore();

		this._replacedRoots.clear();

		editor.editing.view.focus();
	}

	/**
	 * Focuses the textarea containing document source from the first editing root.
	 *
	 * @private
	 */
	_focusSourceEditing() {
		const [ domSourceEditingElementWrapper ] = this._replacedRoots.values();

		domSourceEditingElementWrapper.querySelector( 'textarea' ).focus();
	}

	/**
	 * Disables all commands.
	 *
	 * @private
	 */
	_disableCommands() {
		const editor = this.editor;

		for ( const command of editor.commands.commands() ) {
			command.forceDisabled( COMMAND_FORCE_DISABLE_ID );
		}
	}

	/**
	 * Clears forced disable for all commands, that was previously set through {@link #_disableCommands}.
	 *
	 * @private
	 */
	_enableCommands() {
		const editor = this.editor;

		for ( const command of editor.commands.commands() ) {
			command.clearForceDisabled( COMMAND_FORCE_DISABLE_ID );
		}
	}

	/**
	 * Adds or removes the `readonly` attribute from textarea from all roots, if document source mode is active.
	 *
	 * @param {Boolean} isReadOnly Indicates whether all textarea elements should be read-only.
	 */
	_handleReadOnlyMode( isReadOnly ) {
		if ( !this.isSourceEditingMode ) {
			return;
		}

		for ( const [ , domSourceEditingElementWrapper ] of this._replacedRoots ) {
			domSourceEditingElementWrapper.querySelector( 'textarea' ).readOnly = isReadOnly;
		}
	}

	/**
	 * Checks, if the editor's editable belongs to the editor's DOM tree.
	 *
	 * @private
	 * @returns {Boolean}
	 */
	_isAllowedToHandleSourceEditingMode() {
		const editor = this.editor;
		const editable = editor.ui.view.editable;

		return editable && !editable._hasExternalElement;
	}
}