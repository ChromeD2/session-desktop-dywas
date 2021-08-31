import React from 'react';

import classNames from 'classnames';

import {
  SendMessageType,
  SessionCompositionBox,
  StagedAttachmentType,
} from './SessionCompositionBox';

import { Constants } from '../../../session';
import _ from 'lodash';
import { AttachmentUtil, GoogleChrome } from '../../../util';
import { ConversationHeaderWithDetails } from '../../conversation/ConversationHeader';
import { SessionRightPanelWithDetails } from './SessionRightPanel';
import { SessionTheme } from '../../../state/ducks/SessionTheme';
import styled from 'styled-components';
import { SessionMessagesListContainer } from './SessionMessagesListContainer';
import { LightboxGallery, MediaItemType } from '../../LightboxGallery';

import { AttachmentTypeWithPath } from '../../../types/Attachment';
import { ToastUtils, UserUtils } from '../../../session/utils';
import * as MIME from '../../../types/MIME';
import { SessionFileDropzone } from './SessionFileDropzone';
import {
  quoteMessage,
  ReduxConversationType,
  resetSelectedMessageIds,
  SortedMessageModelProps,
  updateMentionsMembers,
} from '../../../state/ducks/conversations';
import { MessageView } from '../../MainViewController';
import { MessageDetail } from '../../conversation/MessageDetail';
import { getConversationController } from '../../../session/conversations';
import { getPubkeysInPublicConversation } from '../../../data/data';
import autoBind from 'auto-bind';
import { useSelector } from 'react-redux';
import {
  getFirstUnreadMessageId,
  isFirstUnreadMessageIdAbove,
} from '../../../state/selectors/conversations';

import { SessionButtonColor } from '../SessionButton';
import { updateConfirmModal } from '../../../state/ducks/modalDialog';
import { addStagedAttachmentsInConversation } from '../../../state/ducks/stagedAttachments';

interface State {
  showRecordingView: boolean;
  isDraggingFile: boolean;
}
export interface LightBoxOptions {
  media: Array<MediaItemType>;
  attachment: AttachmentTypeWithPath;
}

interface Props {
  ourNumber: string;
  selectedConversationKey: string;
  selectedConversation?: ReduxConversationType;
  messagesProps: Array<SortedMessageModelProps>;
  selectedMessages: Array<string>;
  showMessageDetails: boolean;
  isRightPanelShowing: boolean;

  // lightbox options
  lightBoxOptions?: LightBoxOptions;

  stagedAttachments: Array<StagedAttachmentType>;
}

const SessionUnreadAboveIndicator = styled.div`
  position: sticky;
  top: 0;
  margin: 1em;
  display: flex;
  justify-content: center;
  background: var(--color-sent-message-background);
  color: var(--color-sent-message-text);
`;

const UnreadAboveIndicator = () => {
  const isFirstUnreadAbove = useSelector(isFirstUnreadMessageIdAbove);
  const firstUnreadMessageId = useSelector(getFirstUnreadMessageId) as string;

  if (!isFirstUnreadAbove) {
    return null;
  }
  return (
    <SessionUnreadAboveIndicator key={`above-unread-indicator-${firstUnreadMessageId}`}>
      {window.i18n('latestUnreadIsAbove')}
    </SessionUnreadAboveIndicator>
  );
};

export class SessionConversation extends React.Component<Props, State> {
  private readonly messageContainerRef: React.RefObject<HTMLDivElement>;
  private dragCounter: number;
  private publicMembersRefreshTimeout?: NodeJS.Timeout;
  private readonly updateMemberList: () => any;

  constructor(props: any) {
    super(props);

    this.state = {
      showRecordingView: false,
      isDraggingFile: false,
    };
    this.messageContainerRef = React.createRef();
    this.dragCounter = 0;
    this.updateMemberList = _.debounce(this.updateMemberListBouncy.bind(this), 1000);

    autoBind(this);
  }

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // ~~~~~~~~~~~~~~~~ LIFECYCLES ~~~~~~~~~~~~~~~~
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

  public componentDidUpdate(prevProps: Props, _prevState: State) {
    const {
      selectedConversationKey: newConversationKey,
      selectedConversation: newConversation,
    } = this.props;
    const { selectedConversationKey: oldConversationKey } = prevProps;

    // if the convo is valid, and it changed, register for drag events
    if (newConversationKey && newConversation && newConversationKey !== oldConversationKey) {
      // Pause thread to wait for rendering to complete
      setTimeout(() => {
        const div = this.messageContainerRef.current;
        div?.addEventListener('dragenter', this.handleDragIn);
        div?.addEventListener('dragleave', this.handleDragOut);
        div?.addEventListener('dragover', this.handleDrag);
        div?.addEventListener('drop', this.handleDrop);
      }, 100);

      // if the conversation changed, we have to stop our refresh of member list
      if (this.publicMembersRefreshTimeout) {
        global.clearInterval(this.publicMembersRefreshTimeout);
        this.publicMembersRefreshTimeout = undefined;
      }
      // if the newConversation changed, and is public, start our refresh members list
      if (newConversation.isPublic) {
        // this is a debounced call.
        void this.updateMemberList();
        // run this only once every minute if we don't change the visible conversation.
        // this is a heavy operation (like a few thousands members can be here)
        this.publicMembersRefreshTimeout = global.setInterval(this.updateMemberList, 60000);
      }
    }
    // if we do not have a model, unregister for events
    if (!newConversation) {
      const div = this.messageContainerRef.current;
      div?.removeEventListener('dragenter', this.handleDragIn);
      div?.removeEventListener('dragleave', this.handleDragOut);
      div?.removeEventListener('dragover', this.handleDrag);
      div?.removeEventListener('drop', this.handleDrop);
      if (this.publicMembersRefreshTimeout) {
        global.clearInterval(this.publicMembersRefreshTimeout);
        this.publicMembersRefreshTimeout = undefined;
      }
    }
    if (newConversationKey !== oldConversationKey) {
      this.setState({
        showRecordingView: false,
        isDraggingFile: false,
      });
    }
  }

  public componentWillUnmount() {
    const div = this.messageContainerRef.current;
    div?.removeEventListener('dragenter', this.handleDragIn);
    div?.removeEventListener('dragleave', this.handleDragOut);
    div?.removeEventListener('dragover', this.handleDrag);
    div?.removeEventListener('drop', this.handleDrop);

    if (this.publicMembersRefreshTimeout) {
      global.clearInterval(this.publicMembersRefreshTimeout);
      this.publicMembersRefreshTimeout = undefined;
    }
  }

  public sendMessageFn(msg: SendMessageType) {
    const { selectedConversationKey } = this.props;
    const conversationModel = getConversationController().get(selectedConversationKey);

    if (!conversationModel) {
      return;
    }

    const sendAndScroll = () => {
      void conversationModel.sendMessage(msg);
      if (this.messageContainerRef.current) {
        (this.messageContainerRef
          .current as any).scrollTop = this.messageContainerRef.current?.scrollHeight;
      }
    };

    // const recoveryPhrase = window.textsecure.storage.get('mnemonic');
    const recoveryPhrase = UserUtils.getCurrentRecoveryPhrase();

    // string replace to fix case where pasted text contains invis characters causing false negatives
    if (msg.body.replace(/\s/g, '').includes(recoveryPhrase.replace(/\s/g, ''))) {
      window.inboxStore?.dispatch(
        updateConfirmModal({
          title: window.i18n('sendRecoveryPhraseTitle'),
          message: window.i18n('sendRecoveryPhraseMessage'),
          okTheme: SessionButtonColor.Danger,
          onClickOk: () => {
            sendAndScroll();
          },
          onClickClose: () => {
            window.inboxStore?.dispatch(updateConfirmModal(null));
          },
        })
      );
    } else {
      sendAndScroll();
    }

    window.inboxStore?.dispatch(quoteMessage(undefined));
  }

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // ~~~~~~~~~~~~~~ RENDER METHODS ~~~~~~~~~~~~~~
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  public render() {
    const { showRecordingView, isDraggingFile } = this.state;

    const {
      selectedConversation,
      messagesProps,
      showMessageDetails,
      selectedMessages,
      isRightPanelShowing,
      lightBoxOptions,
    } = this.props;

    if (!selectedConversation || !messagesProps) {
      // return an empty message view
      return <MessageView />;
    }

    const selectionMode = selectedMessages.length > 0;

    return (
      <SessionTheme>
        <div className="conversation-header">
          <ConversationHeaderWithDetails />
        </div>
        <div
          // if you change the classname, also update it on onKeyDown
          className={classNames('conversation-content', selectionMode && 'selection-mode')}
          tabIndex={0}
          onKeyDown={this.onKeyDown}
          role="navigation"
        >
          <div className={classNames('conversation-info-panel', showMessageDetails && 'show')}>
            <MessageDetail />
          </div>

          {lightBoxOptions?.media && this.renderLightBox(lightBoxOptions)}

          <div className="conversation-messages">
            <UnreadAboveIndicator />

            <SessionMessagesListContainer messageContainerRef={this.messageContainerRef} />

            {showRecordingView && <div className="conversation-messages__blocking-overlay" />}
            {isDraggingFile && <SessionFileDropzone />}
          </div>

          <SessionCompositionBox
            sendMessage={this.sendMessageFn}
            stagedAttachments={this.props.stagedAttachments}
            onLoadVoiceNoteView={this.onLoadVoiceNoteView}
            onExitVoiceNoteView={this.onExitVoiceNoteView}
            onChoseAttachments={this.onChoseAttachments}
          />
        </div>
        <div
          className={classNames('conversation-item__options-pane', isRightPanelShowing && 'show')}
        >
          <SessionRightPanelWithDetails />
        </div>
      </SessionTheme>
    );
  }

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // ~~~~~~~~~~~~ MICROPHONE METHODS ~~~~~~~~~~~~
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  private onLoadVoiceNoteView() {
    this.setState({
      showRecordingView: true,
    });
    window.inboxStore?.dispatch(resetSelectedMessageIds());
  }

  private onExitVoiceNoteView() {
    this.setState({
      showRecordingView: false,
    });
  }

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // ~~~~~~~~~~~ KEYBOARD NAVIGATION ~~~~~~~~~~~~
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  private onKeyDown(event: any) {
    const selectionMode = !!this.props.selectedMessages.length;
    const recordingMode = this.state.showRecordingView;
    if (event.key === 'Escape') {
      // EXIT MEDIA VIEW
      if (recordingMode) {
        // EXIT RECORDING VIEW
      }
      // EXIT WHAT ELSE?
    }
    if (event.target.classList.contains('conversation-content')) {
      switch (event.key) {
        case 'Escape':
          if (selectionMode) {
            window.inboxStore?.dispatch(resetSelectedMessageIds());
          }
          break;
        default:
      }
    }
  }

  private renderLightBox({ media, attachment }: LightBoxOptions) {
    const selectedIndex =
      media.length > 1
        ? media.findIndex(mediaMessage => mediaMessage.attachment.path === attachment.path)
        : 0;
    return <LightboxGallery media={media} selectedIndex={selectedIndex} />;
  }

  private async onChoseAttachments(attachmentsFileList: Array<File>) {
    if (!attachmentsFileList || attachmentsFileList.length === 0) {
      return;
    }

    // tslint:disable-next-line: prefer-for-of
    for (let i = 0; i < attachmentsFileList.length; i++) {
      await this.maybeAddAttachment(attachmentsFileList[i]);
    }
  }

  // tslint:disable: max-func-body-length cyclomatic-complexity
  private async maybeAddAttachment(file: any) {
    if (!file) {
      return;
    }

    const fileName = file.name;
    const contentType = file.type;

    const { stagedAttachments } = this.props;

    if (window.Signal.Util.isFileDangerous(fileName)) {
      ToastUtils.pushDangerousFileError();
      return;
    }

    if (stagedAttachments.length >= 32) {
      ToastUtils.pushMaximumAttachmentsError();
      return;
    }

    const haveNonImage = _.some(
      stagedAttachments,
      attachment => !MIME.isImage(attachment.contentType)
    );
    // You can't add another attachment if you already have a non-image staged
    if (haveNonImage) {
      ToastUtils.pushMultipleNonImageError();
      return;
    }

    // You can't add a non-image attachment if you already have attachments staged
    if (!MIME.isImage(contentType) && stagedAttachments.length > 0) {
      ToastUtils.pushCannotMixError();
      return;
    }
    const { VisualAttachment } = window.Signal.Types;

    const renderVideoPreview = async () => {
      const objectUrl = URL.createObjectURL(file);
      try {
        const type = 'image/png';

        const thumbnail = await VisualAttachment.makeVideoScreenshot({
          objectUrl,
          contentType: type,
          logger: window.log,
        });
        const data = await VisualAttachment.blobToArrayBuffer(thumbnail);
        const url = window.Signal.Util.arrayBufferToObjectURL({
          data,
          type,
        });
        this.addAttachments([
          {
            file,
            size: file.size,
            fileName,
            contentType,
            videoUrl: objectUrl,
            url,
            isVoiceMessage: false,
            fileSize: null,
            screenshot: null,
            thumbnail: null,
          },
        ]);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
      }
    };

    const renderImagePreview = async () => {
      if (!MIME.isJPEG(contentType)) {
        const urlImage = URL.createObjectURL(file);
        if (!urlImage) {
          throw new Error('Failed to create object url for image!');
        }
        this.addAttachments([
          {
            file,
            size: file.size,
            fileName,
            contentType,
            url: urlImage,
            isVoiceMessage: false,
            fileSize: null,
            screenshot: null,
            thumbnail: null,
          },
        ]);
        return;
      }

      const url = await window.autoOrientImage(file);

      this.addAttachments([
        {
          file,
          size: file.size,
          fileName,
          contentType,
          url,
          isVoiceMessage: false,
          fileSize: null,
          screenshot: null,
          thumbnail: null,
        },
      ]);
    };

    let blob = null;

    try {
      blob = await AttachmentUtil.autoScale({
        contentType,
        file,
      });

      if (blob.file.size >= Constants.CONVERSATION.MAX_ATTACHMENT_FILESIZE_BYTES) {
        ToastUtils.pushFileSizeErrorAsByte(Constants.CONVERSATION.MAX_ATTACHMENT_FILESIZE_BYTES);
        return;
      }
    } catch (error) {
      window?.log?.error(
        'Error ensuring that image is properly sized:',
        error && error.stack ? error.stack : error
      );

      ToastUtils.pushLoadAttachmentFailure(error?.message);
      return;
    }

    try {
      if (GoogleChrome.isImageTypeSupported(contentType)) {
        // this does not add the preview to the message outgoing
        // this is just for us, for the list of attachments we are sending
        // the files are scaled down under getFiles()

        await renderImagePreview();
      } else if (GoogleChrome.isVideoTypeSupported(contentType)) {
        await renderVideoPreview();
      } else {
        this.addAttachments([
          {
            file,
            size: file.size,
            contentType,
            fileName,
            url: '',
            isVoiceMessage: false,
            fileSize: null,
            screenshot: null,
            thumbnail: null,
          },
        ]);
      }
    } catch (e) {
      window?.log?.error(
        `Was unable to generate thumbnail for file type ${contentType}`,
        e && e.stack ? e.stack : e
      );
      this.addAttachments([
        {
          file,
          size: file.size,
          contentType,
          fileName,
          isVoiceMessage: false,
          url: '',
          fileSize: null,
          screenshot: null,
          thumbnail: null,
        },
      ]);
    }
  }

  private addAttachments(newAttachments: Array<StagedAttachmentType>) {
    window.inboxStore?.dispatch(
      addStagedAttachmentsInConversation({
        conversationKey: this.props.selectedConversationKey,
        newAttachments,
      })
    );
  }

  private handleDrag(e: any) {
    e.preventDefault();
    e.stopPropagation();
  }

  private handleDragIn(e: any) {
    e.preventDefault();
    e.stopPropagation();
    this.dragCounter++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      this.setState({ isDraggingFile: true });
    }
  }

  private handleDragOut(e: any) {
    e.preventDefault();
    e.stopPropagation();
    this.dragCounter--;

    if (this.dragCounter === 0) {
      this.setState({ isDraggingFile: false });
    }
  }

  private handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (e?.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void this.onChoseAttachments(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
      this.dragCounter = 0;
      this.setState({ isDraggingFile: false });
    }
  }

  private async updateMemberListBouncy() {
    const allPubKeys = await getPubkeysInPublicConversation(this.props.selectedConversationKey);

    window?.log?.info(`getPubkeysInPublicConversation returned '${allPubKeys?.length}' members`);

    const allMembers = allPubKeys.map((pubKey: string) => {
      const conv = getConversationController().get(pubKey);
      const profileName = conv?.getProfileName() || 'Anonymous';

      return {
        id: pubKey,
        authorPhoneNumber: pubKey,
        authorProfileName: profileName,
      };
    });

    window.inboxStore?.dispatch(updateMentionsMembers(allMembers));
  }
}
