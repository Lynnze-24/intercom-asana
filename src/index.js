import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import FormData from 'form-data';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Asana configuration
const ASANA_TOKEN =
  '2/1212353370344534/1212340334177314:423f18d3f0b9a38f0e75513a31350873';
const ASANA_WORKSPACE = '1211014974336131';
const ASANA_PROJECT = '1212353369442239';

// Asana Custom Field GIDs - Will be automatically populated on server start
const ASANA_CUSTOM_FIELDS = {
  WALLET: null,
  PAYMENT_GATEWAY: null,
  TRANSACTION_ID: null,
  AMOUNT: null,
  AGENT_REMARK: null,
};

// Cache for custom field mappings
let customFieldsCache = null;

// Intercom configuration
const INTERCOM_TOKEN =
  'dG9rOmQxMmIxYTQxXzcwMDhfNGE2Ml9iODU1XzQ5MjFkNjA4NWRlZDoxOjA=';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

/*
  This object defines the canvas that will display when your app initializes.
  It includes a button to create an Asana task for the contact.
  
  More information on these can be found in the reference docs.
  Canvas docs: https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/
  Components docs: https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/
*/
const initialCanvas = {
  canvas: {
    content: {
      components: [
        {
          type: 'text',
          id: 'header',
          text: 'Create Asana Task for Contact',
          align: 'center',
          style: 'header',
        },
        {
          type: 'button',
          label: 'Create Asana Task',
          style: 'primary',
          id: 'submit_button',
          action: {
            type: 'submit',
          },
        },
      ],
    },
  },
};

// Helper function to get contact name from Intercom API
async function getContactName(contactId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/contacts/${contactId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.name || 'Unknown Contact';
    }
    return 'Unknown Contact';
  } catch (error) {
    console.error('Error fetching contact from Intercom:', error);
    return 'Unknown Contact';
  }
}

// Helper function to get conversation details from Intercom API
async function getConversation(conversationId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching conversation from Intercom:', error);
    return null;
  }
}

// Helper function to extract attachment URLs from Intercom conversation
function extractAttachmentUrls(conversation) {
  const attachments = [];

  // Check the main conversation message for attachments
  if (
    conversation.source &&
    conversation.source.attachments &&
    Array.isArray(conversation.source.attachments)
  ) {
    console.log(
      'Found attachments in conversation source:',
      conversation.source.attachments.length
    );
    attachments.push(...conversation.source.attachments);
  }

  // Check each conversation part for attachments
  if (
    conversation.conversation_parts &&
    conversation.conversation_parts.conversation_parts &&
    Array.isArray(conversation.conversation_parts.conversation_parts)
  ) {
    conversation.conversation_parts.conversation_parts.forEach(
      (part, index) => {
        if (part.attachments && Array.isArray(part.attachments)) {
          console.log(
            `Found attachments in conversation part ${index}:`,
            part.attachments.length
          );
          attachments.push(...part.attachments);
        }
      }
    );
  }

  console.log('Total attachments found:', attachments.length);

  // Log each attachment
  attachments.forEach((attachment, index) => {
    console.log(`Attachment ${index + 1}:`);
    console.log('  Name:', attachment.name);
    console.log('  URL:', attachment.url);
    console.log('  Content Type:', attachment.content_type);
  });

  return attachments;
}

// Helper function to update Intercom conversation custom attributes
async function updateConversationAttribute(conversationId, asanaTaskId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          custom_attributes: {
            AsanaTaskID: asanaTaskId,
          },
        }),
      }
    );

    if (response.ok) {
      console.log('Successfully updated conversation with Asana task ID');
      return true;
    } else {
      const errorData = await response.json();
      console.error('Error updating conversation:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating conversation attribute:', error);
    return false;
  }
}

// Helper function to get custom field settings for a project
async function getAsanaCustomFields() {
  try {
    const response = await fetch(
      `https://app.asana.com/api/1.0/projects/${ASANA_PROJECT}/custom_field_settings`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    return null;
  }
}

// Helper function to initialize custom field mappings
async function initializeCustomFieldMappings() {
  try {
    console.log('Fetching Asana custom field mappings...');
    const customFieldSettings = await getAsanaCustomFields();

    if (!customFieldSettings || customFieldSettings.length === 0) {
      console.warn('⚠ No custom fields found in Asana project');
      console.warn(
        'Custom field syncing will be disabled. Please add custom fields to your Asana project.'
      );
      return null;
    }

    const mappings = {};
    const fieldNames = {
      Wallet: 'WALLET',
      'Payment Gateway': 'PAYMENT_GATEWAY',
      'Transaction ID': 'TRANSACTION_ID',
      Amount: 'AMOUNT',
      'Agent Remark': 'AGENT_REMARK',
    };

    // Map custom field names to their GIDs
    customFieldSettings.forEach((setting) => {
      const fieldName = setting.custom_field.name;
      const fieldGid = setting.custom_field.gid;

      if (fieldNames[fieldName]) {
        const mappingKey = fieldNames[fieldName];
        mappings[mappingKey] = fieldGid;
        console.log(`✓ Mapped "${fieldName}" → ${fieldGid}`);
      }
    });

    // Update the global ASANA_CUSTOM_FIELDS object
    Object.keys(mappings).forEach((key) => {
      ASANA_CUSTOM_FIELDS[key] = mappings[key];
    });

    // Check which fields are missing
    const missingFields = Object.keys(fieldNames).filter(
      (name) => !mappings[fieldNames[name]]
    );

    if (missingFields.length > 0) {
      console.warn(
        '⚠ Missing custom fields in Asana project:',
        missingFields.join(', ')
      );
      console.warn(
        'Please create these fields in your Asana project for full syncing.'
      );
    } else {
      console.log('✓ All custom fields mapped successfully');
    }

    customFieldsCache = mappings;
    return mappings;
  } catch (error) {
    console.error('Error initializing custom field mappings:', error);
    return null;
  }
}

// Helper function to validate if string is a valid URL
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

// Helper function to upload attachment to Asana task
async function uploadAttachmentToAsana(taskId, attachmentUrl) {
  try {
    // Validate if it's a proper URL
    if (!isValidUrl(attachmentUrl)) {
      console.error('Invalid attachment URL:', attachmentUrl);
      console.log(
        'The attachment field appears to be an ID or invalid URL. Please provide a full URL.'
      );
      return null;
    }

    // Download the file from the attachment URL
    console.log('===== ATTACHMENT DOWNLOAD PROCESS =====');
    console.log('Full attachment URL:', attachmentUrl);
    console.log('Attempting to download...');

    const fileResponse = await fetch(attachmentUrl);

    if (!fileResponse.ok) {
      console.error(
        'Failed to download attachment. Status:',
        fileResponse.status
      );
      console.error('Status Text:', fileResponse.statusText);
      return null;
    }

    console.log('✓ Successfully downloaded attachment');
    console.log('Content-Type:', fileResponse.headers.get('content-type'));
    console.log('Content-Length:', fileResponse.headers.get('content-length'));

    // Get the file buffer and content type
    const fileBuffer = await fileResponse.buffer();
    const contentType =
      fileResponse.headers.get('content-type') || 'application/octet-stream';

    // Extract filename from URL or use a default
    const urlParts = attachmentUrl.split('/');
    const fileName =
      urlParts[urlParts.length - 1].split('?')[0] || 'attachment';

    // Create form data for multipart upload
    const formData = new FormData();
    formData.append('parent', taskId);
    formData.append('file', fileBuffer, {
      filename: fileName,
      contentType: contentType,
    });

    // Upload to Asana
    console.log('===== ASANA UPLOAD PROCESS =====');
    console.log('Uploading to Asana task ID:', taskId);
    console.log('File name:', fileName);
    console.log('Content type:', contentType);
    console.log('File size:', fileBuffer.length, 'bytes');

    const asanaResponse = await fetch(
      'https://app.asana.com/api/1.0/attachments',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    if (asanaResponse.ok) {
      const asanaData = await asanaResponse.json();
      const permanentUrl =
        asanaData.data.permanent_url || asanaData.data.download_url;
      console.log('✓ Successfully uploaded attachment to Asana');
      console.log('Asana permanent URL:', permanentUrl);
      console.log('======================================');
      return permanentUrl;
    } else {
      const errorData = await asanaResponse.json();
      console.error('✗ Error uploading attachment to Asana:', errorData);
      console.error('======================================');
      return null;
    }
  } catch (error) {
    console.error('Error in uploadAttachmentToAsana:', error);
    return null;
  }
}

// Root route - serves the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper endpoint to get custom field GIDs and current mappings
app.get('/asana-custom-fields', async (req, res) => {
  try {
    const customFieldSettings = await getAsanaCustomFields();

    if (customFieldSettings) {
      const fields = customFieldSettings.map((setting) => ({
        name: setting.custom_field.name,
        gid: setting.custom_field.gid,
        type: setting.custom_field.resource_type,
        description: setting.custom_field.description,
      }));

      res.json({
        success: true,
        project_id: ASANA_PROJECT,
        all_custom_fields: fields,
        mapped_fields: {
          WALLET: ASANA_CUSTOM_FIELDS.WALLET,
          PAYMENT_GATEWAY: ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY,
          TRANSACTION_ID: ASANA_CUSTOM_FIELDS.TRANSACTION_ID,
          AMOUNT: ASANA_CUSTOM_FIELDS.AMOUNT,
          AGENT_REMARK: ASANA_CUSTOM_FIELDS.AGENT_REMARK,
        },
        message:
          'Custom fields are automatically mapped on server start. Check mapped_fields to see current mappings.',
      });
    } else {
      res.json({
        success: false,
        message: 'Failed to fetch custom fields from Asana',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/*
  This is an endpoint that Intercom will POST HTTP request when a teammate inserts 
  the app into the inbox, or a new conversation is viewed.
*/
app.post('/initialize', async (req, res) => {
  console.log('Initialize endpoint hit');
  console.log('Initialize request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const asanaTaskId = conversation?.custom_attributes?.AsanaTaskID;

    if (asanaTaskId) {
      // Conversation already has an Asana task, show completed state
      const completedCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'success',
                text: '✓ Asana Task Already Created',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'task_id',
                text: `Task ID: ${asanaTaskId}`,
                align: 'center',
                style: 'paragraph',
              },
              {
                type: 'text',
                id: 'info',
                text: 'This conversation already has an Asana task associated with it.',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      return res.send(completedCanvas);
    }
  }

  // No existing task, show create button
  res.send(initialCanvas);
});

/*
  When a submit action is taken in a canvas component, it will hit this endpoint.
  This endpoint creates an Asana task with the contact's name and prevents
  duplicate submissions per conversation.
*/
app.post('/submit', async (req, res) => {
  console.log('Submit endpoint hit with component_id:', req.body.component_id);
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const existingTaskId = conversation?.custom_attributes?.AsanaTaskID;

    if (existingTaskId) {
      const alreadySubmittedCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'already_submitted',
                text: 'Task already created for this conversation',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'task_id',
                text: `Task ID: ${existingTaskId}`,
                align: 'center',
                style: 'paragraph',
              },
              {
                type: 'text',
                id: 'info',
                text: 'You can only create one Asana task per conversation.',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      return res.send(alreadySubmittedCanvas);
    }
  }

  if (req.body.component_id === 'submit_button') {
    try {
      // Extract contact name from Intercom data
      let contactName =
        req.body.contact?.name || req.body.customer?.name || null;

      // If no name in request body, fetch from Intercom API
      if (!contactName) {
        const contactId = req.body.contact?.id || req.body.customer?.id;
        if (contactId) {
          contactName = await getContactName(contactId);
        } else {
          contactName = 'Unknown Contact';
        }
      }

      // Get full conversation details to access custom attributes and attachments
      const fullConversation = await getConversation(conversationId);
      const customAttrs = fullConversation?.custom_attributes || {};

      // Extract attachments from conversation
      console.log('Extracting attachments from conversation...');
      const attachments = extractAttachmentUrls(fullConversation);
      const attachmentUrl = attachments.length > 0 ? attachments[0].url : null;

      if (attachmentUrl) {
        console.log('Will use attachment URL:', attachmentUrl);
      } else {
        console.log('No attachments found in conversation');
      }

      // Extract the 5 custom fields (attachment is now from conversation parts)
      const wallet = customAttrs.Wallet || '';
      const paymentGateway = customAttrs['Payment Gateway'] || '';
      const transactionID = customAttrs['Transaction ID'] || '';
      const amount = customAttrs.Amount || '';
      const agentRemark = customAttrs['Agent Remark'] || '';

      // Build basic task notes
      const taskNotes = `Task created from Intercom conversation ${conversationId}

Contact Information:
- Name: ${contactName}
- Email: ${req.body.contact?.email || req.body.customer?.email || 'N/A'}`;

      // Ensure custom fields are initialized (fallback if server start failed)
      if (!customFieldsCache) {
        console.log('Custom fields not initialized, initializing now...');
        await initializeCustomFieldMappings();
      }

      // Build custom fields object for Asana
      // All values must be converted to strings for Asana API
      const customFields = {};

      if (ASANA_CUSTOM_FIELDS.WALLET && wallet) {
        customFields[ASANA_CUSTOM_FIELDS.WALLET] = String(wallet);
      }
      if (ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY && paymentGateway) {
        customFields[ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY] =
          String(paymentGateway);
      }
      if (ASANA_CUSTOM_FIELDS.TRANSACTION_ID && transactionID) {
        customFields[ASANA_CUSTOM_FIELDS.TRANSACTION_ID] =
          String(transactionID);
      }
      if (ASANA_CUSTOM_FIELDS.AMOUNT && amount) {
        customFields[ASANA_CUSTOM_FIELDS.AMOUNT] = String(amount);
      }
      if (ASANA_CUSTOM_FIELDS.AGENT_REMARK && agentRemark) {
        customFields[ASANA_CUSTOM_FIELDS.AGENT_REMARK] = String(agentRemark);
      }

      console.log('Custom fields to sync:', Object.keys(customFields).length);
      if (Object.keys(customFields).length > 0) {
        console.log('Custom field values (as strings):', customFields);
      }

      // Create task payload
      const taskPayload = {
        workspace: ASANA_WORKSPACE,
        projects: [ASANA_PROJECT],
        name: contactName,
        notes: taskNotes,
      };

      // Only add custom_fields if we have any configured
      if (Object.keys(customFields).length > 0) {
        taskPayload.custom_fields = customFields;
      }

      console.log(
        'Creating Asana task with payload:',
        JSON.stringify(taskPayload, null, 2)
      );

      // Create Asana task
      const asanaResponse = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: taskPayload,
        }),
      });

      const asanaData = await asanaResponse.json();

      if (asanaResponse.ok) {
        const asanaTaskId = asanaData.data.gid;

        // Upload attachment to Asana if available
        let attachmentPermanentUrl = null;
        let attachmentStatus = null;
        if (attachmentUrl && attachmentUrl !== 'N/A') {
          console.log('\n===== ATTACHMENT PROCESSING =====');
          console.log('Found attachment to process');
          console.log('Attachment URL:', attachmentUrl);

          // Check if it's a valid URL before attempting upload
          if (!isValidUrl(attachmentUrl)) {
            console.log(
              '⚠ Attachment field is not a valid URL, skipping upload'
            );
            attachmentStatus = 'invalid_url';
          } else {
            console.log('✓ Valid URL detected, proceeding with upload');
            attachmentPermanentUrl = await uploadAttachmentToAsana(
              asanaTaskId,
              attachmentUrl
            );

            if (attachmentPermanentUrl) {
              console.log(
                '✓ Final attachment permanent URL:',
                attachmentPermanentUrl
              );
              attachmentStatus = 'success';
            } else {
              console.log('✗ Attachment upload failed');
              attachmentStatus = 'failed';
            }
          }
          console.log('==================================\n');
        } else {
          console.log('No attachments to process for this task');
        }

        // Save Asana task ID to Intercom conversation
        await updateConversationAttribute(conversationId, asanaTaskId);

        const components = [
          {
            type: 'text',
            id: 'success',
            text: '✓ Asana Task Created',
            align: 'center',
            style: 'header',
          },
          {
            type: 'text',
            id: 'task_name',
            text: `Task: ${contactName}`,
            align: 'center',
            style: 'paragraph',
          },
          {
            type: 'text',
            id: 'task_id',
            text: `Task ID: ${asanaTaskId}`,
            align: 'center',
            style: 'paragraph',
          },
        ];

        // Add attachment status if attachment was processed
        if (attachmentUrl && attachmentStatus) {
          let statusText = '';
          if (attachmentStatus === 'success') {
            statusText = '✓ Attachment uploaded successfully';
          } else if (attachmentStatus === 'invalid_url') {
            statusText =
              '⚠ Attachment field is not a valid URL (ID: ' +
              attachmentUrl +
              ')';
          } else {
            statusText = '⚠ Attachment upload failed';
          }

          components.push({
            type: 'text',
            id: 'attachment_status',
            text: statusText,
            align: 'center',
            style: 'paragraph',
          });
        }

        const syncedFieldsText =
          Object.keys(customFields).length > 0
            ? `✓ Synced ${
                Object.keys(customFields).length
              } custom fields to Asana`
            : '⚠ Configure ASANA_CUSTOM_FIELDS to sync custom fields';

        components.push({
          type: 'text',
          id: 'synced_fields',
          text: syncedFieldsText,
          align: 'center',
          style: 'paragraph',
        });

        const successCanvas = {
          canvas: {
            content: {
              components: components,
            },
          },
        };
        res.send(successCanvas);
      } else {
        throw new Error(
          asanaData.errors?.[0]?.message || 'Failed to create Asana task'
        );
      }
    } catch (error) {
      console.error('Error creating Asana task:', error);

      const errorCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'error',
                text: 'Error Creating Task',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'error_message',
                text: error.message || 'An unexpected error occurred',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      res.send(errorCanvas);
    }
  } else {
    res.send(initialCanvas);
  }
});

const listener = app.listen(PORT, async () => {
  console.log(`Your app is listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view your app`);
  console.log('\n========================================');

  // Initialize custom field mappings from Asana
  await initializeCustomFieldMappings();

  console.log('========================================\n');
  console.log('✓ Server is ready to accept requests');
});
