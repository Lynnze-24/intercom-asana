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

// Helper function to upload attachment to Asana task
async function uploadAttachmentToAsana(taskId, attachmentUrl) {
  try {
    // Download the file from the attachment URL
    console.log('Downloading attachment from:', attachmentUrl);
    const fileResponse = await fetch(attachmentUrl);

    if (!fileResponse.ok) {
      console.error('Failed to download attachment');
      return null;
    }

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
    console.log('Uploading attachment to Asana task:', taskId);
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
      console.log('Successfully uploaded attachment to Asana');
      return asanaData.data.permanent_url || asanaData.data.download_url;
    } else {
      const errorData = await asanaResponse.json();
      console.error('Error uploading attachment to Asana:', errorData);
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

      // Get full conversation details to access custom attributes
      const fullConversation = await getConversation(conversationId);
      const customAttrs = fullConversation?.custom_attributes || {};

      // Extract the 6 custom fields
      const attachmentUrl = customAttrs.attachment || null;
      const wallet = customAttrs.Wallet || 'N/A';
      const paymentGateway = customAttrs['Payment Gateway'] || 'N/A';
      const transactionID = customAttrs['Transaction ID'] || 'N/A';
      const amount = customAttrs.Amount || 'N/A';
      const agentRemark = customAttrs['Agent Remark'] || 'N/A';

      // Build comprehensive notes with all fields
      const taskNotes = `Task created from Intercom conversation ${conversationId}

Contact Information:
- Name: ${contactName}
- Email: ${req.body.contact?.email || req.body.customer?.email || 'N/A'}

Transaction Details:
- Wallet: ${wallet}
- Payment Gateway: ${paymentGateway}
- Transaction ID: ${transactionID}
- Amount: ${amount}
- Agent Remark: ${agentRemark}`;

      // Create Asana task
      const asanaResponse = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            workspace: ASANA_WORKSPACE,
            projects: [ASANA_PROJECT],
            name: contactName,
            notes: taskNotes,
          },
        }),
      });

      const asanaData = await asanaResponse.json();

      if (asanaResponse.ok) {
        const asanaTaskId = asanaData.data.gid;

        // Upload attachment to Asana if available
        let attachmentPermanentUrl = null;
        if (attachmentUrl && attachmentUrl !== 'N/A') {
          console.log('Processing attachment:', attachmentUrl);
          attachmentPermanentUrl = await uploadAttachmentToAsana(
            asanaTaskId,
            attachmentUrl
          );

          if (attachmentPermanentUrl) {
            console.log(
              'Attachment uploaded successfully:',
              attachmentPermanentUrl
            );
          }
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
        if (attachmentUrl) {
          components.push({
            type: 'text',
            id: 'attachment_status',
            text: attachmentPermanentUrl
              ? `✓ Attachment uploaded successfully`
              : `⚠ Attachment upload failed`,
            align: 'center',
            style: 'paragraph',
          });
        }

        components.push({
          type: 'text',
          id: 'synced_fields',
          text: 'Synced: Wallet, Payment Gateway, Transaction ID, Amount, Agent Remark',
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

const listener = app.listen(PORT, () => {
  console.log(`Your app is listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view your app`);
});
